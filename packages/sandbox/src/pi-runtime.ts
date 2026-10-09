import {
	closeSync,
	constants,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { AgentRunError, type ChannelKey, type Logger } from "pi-roundtable";
import { channelSegment, scrubDiagnostic } from "pi-roundtable/kit";
import { ownDirectory } from "./directory-file.ts";
import {
	errorText,
	PI_COMPACT_LIMITS,
	type PiBrokerOptions,
	PiSandboxBroker,
} from "./pi-broker.ts";
import {
	type PiContainerDriver,
	type PiContainerStatus,
	PiDockerContainerDriver,
} from "./pi-container-driver.ts";
import {
	PI_BROKER_SOCKET,
	type PiImage,
	type PiThinkingLevel,
	type PiTurnRequest,
	safeFileName,
	validateImages,
	validateReplyFiles,
} from "./pi-protocol.ts";

/** Moves plain top-level `.jsonl` files into `archive/<time>/`, only after the container is gone. */
function archiveOwnSessions(dir: string, now = new Date()): number {
	if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return 0;
	const files = readdirSync(dir).filter(
		(file) => file.endsWith(".jsonl") && lstatSync(join(dir, file)).isFile(),
	);
	if (files.length === 0) return 0;
	const archive = join(dir, "archive");
	ownDirectory(archive);
	const target = join(archive, now.toISOString().replaceAll(":", "-"));
	ownDirectory(target);
	for (const file of files) renameSync(join(dir, file), join(target, file));
	return files.length;
}

function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Operation cancelled"));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

export interface PiProfile {
	model: string;
	mcp?: readonly string[];
}
export interface PiSandboxRuntimeOptions
	extends Omit<PiBrokerOptions, "model" | "mcp"> {
	/** Existing channelSegment(channel)/workspace/sessions layout is retained. */
	partyDir: string;
	image: string;
	profiles: Readonly<Record<string, PiProfile>>;
	driver?: PiContainerDriver;
	mcp?: PiBrokerOptions["mcp"];
	memory: {
		promptBlock(channel: ChannelKey, id: string, name: string): Promise<string>;
	};
	effort: {
		judge(
			text: string,
			previous: { level: PiThinkingLevel | undefined },
		): Promise<PiThinkingLevel>;
	};
	logger: Logger;
	timeZone?: string;
	containerPrefix?: string;
	labelChannel?: string;
	labelProfile?: string;
	startTimeoutMs?: number;
	turnTimeoutMs?: number;
}
export interface PiSandboxTurn {
	channel: ChannelKey;
	profile: string;
	turnId: string;
	author: { id: string; name: string; principalId?: string };
	text: string;
	images: PiImage[];
	signal?: AbortSignal;
}
export type PiSandboxTurnResult =
	| { ok: true; text: string; files: { name: string; data: Uint8Array }[] }
	| { ok: false; error: AgentRunError };
interface BrokerEntry {
	profile: string;
	broker: PiSandboxBroker;
	stop(): Promise<void>;
}

/** Opt-in full Pi mode. Host state adapters are scoped, never mounted in the worker. */
export class PiSandboxRuntime {
	readonly #options: PiSandboxRuntimeOptions;
	readonly #driver: PiContainerDriver;
	readonly #brokers = new Map<ChannelKey, BrokerEntry>();
	readonly #starts = new Map<ChannelKey, Promise<void>>();
	readonly #active = new Map<ChannelKey, AbortController>();
	readonly #judged = new Map<ChannelKey, PiThinkingLevel>();
	constructor(options: PiSandboxRuntimeOptions) {
		if (!isAbsolute(options.partyDir) || options.partyDir === "/")
			throw new Error("Dedicated absolute state directory required");
		if (!options.driver && process.platform !== "linux")
			throw new Error("Pi sandbox requires native Linux and local Docker");
		if ((process.getuid?.() ?? 0) <= 0 || (process.getgid?.() ?? 0) <= 0)
			throw new Error("Pi sandbox host must be non-root");
		if (
			!/^[a-z0-9][a-z0-9-]{0,40}$/.test(
				options.containerPrefix ?? "roundtable-sandbox",
			)
		)
			throw new Error("Invalid container prefix");
		const turnTimeoutMs = options.turnTimeoutMs ?? 600_000;
		for (const timeout of [turnTimeoutMs, options.startTimeoutMs ?? 90_000])
			if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600_000)
				throw new Error("Invalid runtime deadline");
		// A compactor that runs out of time still leaves Pi's summary half the turn.
		const compaction = options.compaction && {
			...options.compaction,
			timeoutMs:
				options.compaction.timeoutMs ??
				Math.max(
					1000,
					Math.min(PI_COMPACT_LIMITS.timeoutMs, Math.floor(turnTimeoutMs / 3)),
				),
		};
		if (compaction && compaction.timeoutMs > turnTimeoutMs / 2)
			throw new Error("The compactor's timeout must leave half the turn");
		mkdirSync(options.partyDir, { recursive: true, mode: 0o700 });
		const info = statSync(options.partyDir);
		if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
			throw new Error("State directory must be private and host-owned");
		this.#options = {
			...options,
			partyDir: realpathSync(options.partyDir),
			...(compaction ? { compaction } : {}),
		};
		this.#driver =
			options.driver ??
			new PiDockerContainerDriver(undefined, options.labelProfile);
	}
	#segment(channel: ChannelKey): string {
		if (channel.length > 256) throw new Error("Channel key too long");
		const segment = channelSegment(channel);
		const root = join(this.#options.partyDir, segment);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (realpathSync(root) !== root)
			throw new Error("Channel root symlink refused");
		const path = join(root, ".channel-key");
		try {
			const fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			try {
				const data = Buffer.from(channel);
				let written = 0;
				while (written < data.length)
					written += writeSync(fd, data, written, data.length - written);
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
		}
		const fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const data = Buffer.alloc(1025);
			const length = readSync(fd, data, 0, data.length, null);
			if (data.subarray(0, length).toString() !== channel)
				throw new Error("Channel workspace alias refused");
		} finally {
			closeSync(fd);
		}
		return segment;
	}
	#name(channel: ChannelKey): string {
		return `${this.#options.containerPrefix ?? "roundtable-sandbox"}-${this.#segment(channel)}`;
	}
	#paths(channel: ChannelKey) {
		const root = join(this.#options.partyDir, this.#segment(channel));
		return { root, run: join(root, "run"), workspace: join(root, "workspace") };
	}
	attachmentDir(channel: ChannelKey): string {
		return join(this.#paths(channel).workspace, "attachments");
	}
	sessionsDir(channel: ChannelKey): string {
		return join(this.#paths(channel).workspace, "sessions");
	}
	status(channel: ChannelKey): Promise<PiContainerStatus> {
		return this.#driver.status(this.#name(channel));
	}
	async start(channel: ChannelKey, profile: string): Promise<void> {
		const pending = this.#starts.get(channel);
		if (pending) {
			await pending;
			if (this.#brokers.get(channel)?.profile === profile) return;
		}
		const start = this.#start(channel, profile);
		this.#starts.set(channel, start);
		try {
			await start;
		} finally {
			if (this.#starts.get(channel) === start) this.#starts.delete(channel);
		}
	}
	async #start(channel: ChannelKey, profile: string): Promise<void> {
		const selected = Object.hasOwn(this.#options.profiles, profile)
			? this.#options.profiles[profile]
			: undefined;
		if (!selected) throw new Error("Unknown profile");
		const paths = this.#paths(channel);
		// The guest owns what is inside the workspace, so a hostile entry there is replaced, not trusted.
		for (const dir of [paths.root, paths.run, paths.workspace]) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (realpathSync(dir) !== dir)
				throw new Error("Channel directory symlinks refused");
		}
		for (const dir of [
			this.attachmentDir(channel),
			join(paths.workspace, "outbox"),
			this.sessionsDir(channel),
		]) {
			ownDirectory(dir);
			if (realpathSync(dir) !== dir)
				throw new Error("Channel directory symlinks refused");
		}
		let current = this.#brokers.get(channel);
		const state = await this.#driver.status(this.#name(channel));
		const recreate =
			state.state !== "running" ||
			(state.image !== undefined && state.image !== this.#options.image) ||
			(state.profile !== undefined && state.profile !== profile);
		if (current?.profile !== profile || recreate) {
			if (current && recreate) await this.#driver.remove(this.#name(channel));
			await current?.stop();
			const servers = (selected.mcp ?? []).map((name) => {
				const server = this.#options.mcp?.servers.find((s) => s.name === name);
				if (!server) throw new Error(`MCP server ${name} unavailable`);
				return server;
			});
			const broker = new PiSandboxBroker({
				...this.#options,
				model: selected.model,
				mcp: this.#options.mcp ? { ...this.#options.mcp, servers } : undefined,
			});
			const socket = join(paths.run, PI_BROKER_SOCKET);
			if (socket.length > 100) throw new Error("Broker socket path too long");
			rmSync(socket, { force: true });
			const listener = await broker.listen(socket);
			current = { broker, profile, stop: () => listener.stop(true) };
			this.#brokers.set(channel, current);
		}
		await this.#driver.ensureRunning({
			name: this.#name(channel),
			image: this.#options.image,
			channel,
			profile,
			runDir: paths.run,
			workspaceDir: paths.workspace,
			uid: process.getuid?.() ?? 0,
			gid: process.getgid?.() ?? 0,
			timeZone: this.#options.timeZone,
			labelChannel: this.#options.labelChannel,
			labelProfile: this.#options.labelProfile,
		});
		const deadline = Date.now() + (this.#options.startTimeoutMs ?? 90_000);
		while (Date.now() < deadline) {
			this.#active.get(channel)?.signal.throwIfAborted();
			if (current.broker.isReady()) return;
			await Bun.sleep(100);
		}
		throw new Error("Worker did not become ready");
	}
	async stop(channel: ChannelKey): Promise<void> {
		this.#active.get(channel)?.abort();
		await this.#starts.get(channel)?.catch(() => {});
		await this.#driver.remove(this.#name(channel));
		await this.#brokers.get(channel)?.stop();
		this.#brokers.delete(channel);
		this.#judged.delete(channel);
	}
	async startFresh(channel: ChannelKey): Promise<void> {
		await this.stop(channel);
		const archived = archiveOwnSessions(this.sessionsDir(channel));
		// Repair guest-planted entries now, so the next attachment collection does not fail on them.
		ownDirectory(this.attachmentDir(channel));
		this.#options.logger.info(
			{ channel, archived },
			"Sandbox conversation archived",
		);
	}
	async stopBrokers(): Promise<void> {
		for (const controller of this.#active.values()) controller.abort();
		await Promise.allSettled([...this.#starts.values()]);
		await Promise.all([...this.#brokers.values()].map((entry) => entry.stop()));
		this.#brokers.clear();
	}
	/** The worker's last log lines, read before its container is removed, so they are not lost with it. */
	async #logWorker(channel: ChannelKey, turnId: string): Promise<void> {
		if (!this.#driver.logs) return;
		try {
			const lines = await this.#driver.logs(this.#name(channel), 200);
			this.#options.logger.warn(
				{ channel, turnId, lines: scrubDiagnostic(lines, 200_000) },
				"sandbox worker log before removal",
			);
		} catch (error) {
			this.#options.logger.warn(
				{ channel, turnId, error: scrubDiagnostic(errorText(error)) },
				"sandbox worker log unavailable",
			);
		}
	}
	async runTurn(turn: PiSandboxTurn): Promise<PiSandboxTurnResult> {
		if (this.#active.has(turn.channel))
			return { ok: false, error: new AgentRunError("Channel is busy") };
		const controller = new AbortController();
		this.#active.set(turn.channel, controller);
		const turnTimeoutMs = this.#options.turnTimeoutMs ?? 600_000;
		const deadline = Date.now() + turnTimeoutMs;
		const signal = AbortSignal.any([
			controller.signal,
			...(turn.signal ? [turn.signal] : []),
			AbortSignal.timeout(turnTimeoutMs),
		]);
		signal.addEventListener("abort", () => controller.abort(), { once: true });
		const timedOut = () =>
			signal.aborted &&
			signal.reason instanceof DOMException &&
			signal.reason.name === "TimeoutError";
		let release: (() => void) | undefined;
		try {
			signal.throwIfAborted();
			if (
				!safeFileName(turn.turnId) ||
				turn.text.length > 100_000 ||
				turn.author.id.length > 256 ||
				turn.author.name.length > 256 ||
				(turn.author.principalId !== undefined &&
					(typeof turn.author.principalId !== "string" ||
						turn.author.principalId.length === 0 ||
						turn.author.principalId.length > 256))
			)
				throw new Error("Invalid turn input");
			validateImages(turn.images);
			const [thinking] = await abortable(
				signal,
				Promise.all([
					this.#options.effort.judge(turn.text, {
						level: this.#judged.get(turn.channel),
					}),
					this.start(turn.channel, turn.profile),
				]),
			);
			signal.throwIfAborted();
			this.#judged.set(turn.channel, thinking);
			const memory = await abortable(
				signal,
				this.#options.memory.promptBlock(
					turn.channel,
					turn.author.id,
					turn.author.name,
				),
			);
			if (memory.length > 100_000) throw new Error("Memory context too large");
			const request: PiTurnRequest = {
				turnId: turn.turnId,
				author: { ...turn.author },
				text: turn.text,
				memory,
				images: turn.images,
				thinking,
			};
			const entry = this.#brokers.get(turn.channel);
			if (!entry) throw new Error("Broker unavailable");
			release = entry.broker.bind({
				channel: turn.channel,
				profile: turn.profile,
				speaker: turn.author,
				thinking,
				signal,
				deadline,
			});
			const body = await entry.broker.execute(request, signal);
			signal.throwIfAborted();
			if (!body.ok) throw new Error(`Worker turn failed: ${body.error}`);
			validateReplyFiles(body.files);
			const files = body.files.map((file) => ({
				name: file.name,
				data: Buffer.from(file.data, "base64"),
			}));
			return { ok: true, text: body.text, files };
		} catch (error) {
			const failure = {
				message: scrubDiagnostic(errorText(error), 4000),
				timedOut: timedOut(),
				cancelled: signal.aborted && !timedOut(),
			};
			this.#options.logger.error(
				{ channel: turn.channel, turnId: turn.turnId, ...failure },
				"sandbox turn failed",
			);
			// A timed-out Pi session must not keep consuming broker tools or corrupt the next turn.
			if (signal.aborted) {
				await this.#starts.get(turn.channel)?.catch(() => {});
				await this.#logWorker(turn.channel, turn.turnId);
				await this.#driver.remove(this.#name(turn.channel));
			}
			return {
				ok: false,
				error: new AgentRunError(
					failure.timedOut
						? "Sandbox turn timed out"
						: `Sandbox turn failed: ${failure.message}`,
					{ cause: error },
				),
			};
		} finally {
			controller.abort();
			release?.();
			this.#active.delete(turn.channel);
		}
	}
}
