import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorFacts, TurnRequest, TurnResult } from "pi-roundtable";
import { type TestHost, testHost } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import { APP_PROTOCOL } from "../app/protocol.ts";
import { withPushFetch } from "../testing/push.ts";
import { admitAs, refuse, type Verdict } from "../verifier.ts";
import { webConsole } from "../web-plugin.ts";

export const ORIGIN = "https://app.example.test";
export const ADA_DISCORD = "100000000000000001";
export const MEL_DISCORD = "200000000000000002";
/** A guild of this suite's own, so the agents other suites stored in the shared database are not on this team. */
export const GUILD = "900000000000000741";
export const ENTRY_CHANNEL = "900000000000000742";
export const ADA: ActorFacts = {
	provider: "discord",
	subject: ADA_DISCORD,
	name: "Ada",
};
export const MEL: ActorFacts = {
	provider: "discord",
	subject: MEL_DISCORD,
	name: "Mel",
};

/** The sockets' verifier: the header `x-actor` names who the proxy vouches for. */
export function verifier(request: Request): Verdict {
	const who = request.headers.get("x-actor");
	if (who === "owner") {
		const expire = Number(request.headers.get("x-expire-ms"));
		return admitAs(ADA, expire > 0 ? new Date(Date.now() + expire) : undefined);
	}
	if (who === "member") return admitAs(MEL);
	return refuse("no proxy assertion");
}

/** What a scripted turn does; absent, the turn answers by echoing the text. */
type Script = (
	request: TurnRequest,
	signal: AbortSignal,
) => Promise<TurnResult>;

export interface Booted {
	host: TestHost;
	socket: string;
	dataDir: string;
	seen: TurnRequest[];
	scripts: Map<string, Script>;
	stops: string[];
	stop(): Promise<void>;
}

/** Boots the host over the test database with the app's plugin and a runtime that follows scripts. */
export async function boot(options: {
	fetch: typeof fetch;
	graceSeconds?: number;
	/** The push quiet hours; off unless a test asks, so no test depends on the hour it runs at. */
	quietHours?: { start: string; end: string };
}): Promise<Booted> {
	const dataDir = mkdtempSync(join(tmpdir(), "app-socket-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "app-socket-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
	const seen: TurnRequest[] = [];
	const scripts = new Map<string, Script>();
	const running = new Map<string, AbortController>();
	const stops: string[] = [];
	const runtime = {
		runTurn: async (request: TurnRequest): Promise<TurnResult> => {
			seen.push(request);
			const controller = new AbortController();
			running.set(request.channel, controller);
			try {
				const script = [...scripts].find(([marker]) =>
					request.text.includes(marker),
				)?.[1];
				if (script) return await script(request, controller.signal);
				return { ok: true, text: `echo ${request.text}` };
			} finally {
				running.delete(request.channel);
			}
		},
		steer: async () => false,
		stop: (channel: string) => {
			stops.push(channel);
			const controller = running.get(channel as never);
			controller?.abort();
			return controller !== undefined;
		},
		startFresh: async () => undefined,
		deleteConversation: async () => undefined,
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	};
	const host = await testHost({
		config: {
			dataDir,
			discord: { token: "token", guild: GUILD, entryChannel: ENTRY_CHANNEL },
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: ADA_DISCORD,
						identities: [`discord:${ADA_DISCORD}`],
					},
				],
				members: { identities: [`discord:${MEL_DISCORD}`] },
			},
			agents: [
				{
					name: "guide",
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
					channelId: ENTRY_CHANNEL,
				},
				{
					name: "scout",
					displayName: "Scout",
					prompt: "You scout.",
					avatarPrompt: "A scout",
				},
			],
		},
		runtime,
		plugins: [
			webConsole(
				withPushFetch(
					{
						verifier,
						origin: ORIGIN,
						dataDir,
						assetDir: assets,
						cardGraceSeconds: options.graceSeconds ?? 120,
						panes: ["rooms", "schedules", "overview"],
						push: { quietHours: options.quietHours ?? false },
					},
					options.fetch,
				),
			),
		],
	});
	return {
		host,
		socket,
		dataDir,
		seen,
		scripts,
		stops,
		stop: () => host.stop(),
	};
}

/** One app WebSocket and the frames it received. */
export class Client {
	readonly frames: ServerFrame[] = [];
	/** Frames before this index have been passed over by a `take`. */
	#cursor = 0;
	readonly #ws: WebSocket;
	closed: { code: number } | undefined;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = (event) =>
			this.frames.push(JSON.parse(String(event.data)) as ServerFrame);
		ws.onclose = (event) => {
			this.closed = { code: event.code };
		};
	}

	/** Opens a socket, or undefined when the upgrade is refused. */
	static async open(
		boot: Booted,
		headers: Record<string, string>,
		origin: string = ORIGIN,
	): Promise<Client | undefined> {
		const ws = new WebSocket(`ws+unix://${boot.socket}:/console/api/socket`, {
			protocols: [APP_PROTOCOL],
			headers: { origin, ...headers },
		} as never);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			ws.onclose = () => resolve(false);
		});
		return opened ? new Client(ws) : undefined;
	}

	send(frame: object): void {
		this.#ws.send(JSON.stringify(frame));
	}

	/** The first frame after the last one taken that `match` accepts; waits up to `ms`. */
	async take<T extends ServerFrame>(
		match: (frame: ServerFrame) => frame is T,
		ms?: number,
	): Promise<T>;
	async take(
		match: (frame: ServerFrame) => boolean,
		ms?: number,
	): Promise<ServerFrame>;
	async take(
		match: (frame: ServerFrame) => boolean,
		ms = 4000,
	): Promise<ServerFrame> {
		const deadline = Date.now() + ms;
		for (;;) {
			const at = this.frames.findIndex(
				(frame, index) => index >= this.#cursor && match(frame),
			);
			if (at >= 0) {
				this.#cursor = at + 1;
				return this.frames[at] as ServerFrame;
			}
			if (Date.now() > deadline)
				throw new Error(
					`no frame arrived; got ${this.frames.map((f) => f.type).join(", ")}`,
				);
			await Bun.sleep(10);
		}
	}

	/** Whether a frame matching shows up within `ms` (it is not taken). */
	async sees(
		match: (frame: ServerFrame) => boolean,
		ms = 300,
	): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (this.frames.some((f, index) => index >= this.#cursor && match(f)))
				return true;
			await Bun.sleep(10);
		}
		return false;
	}

	close(): void {
		this.#ws.close();
	}
}

export const ofType =
	<K extends ServerFrame["type"]>(type: K) =>
	(frame: ServerFrame): frame is Extract<ServerFrame, { type: K }> =>
		frame.type === type;

export const agentReply = (agent: string) => (frame: ServerFrame) =>
	frame.type === "message" && frame.message.agent === agent;

/** A request to the app's REST over the host's unix socket. */
export function rest(
	boot: Booted,
	path: string,
	init: RequestInit & { who?: string; origin?: string | null } = {},
): Promise<Response> {
	const { who = "owner", origin = ORIGIN, ...rest } = init;
	return fetch(`http://localhost/console/api/${path}`, {
		...rest,
		headers: {
			"x-actor": who,
			...(origin ? { origin } : {}),
			...(rest.body ? { "content-type": "application/json" } : {}),
			...(rest.headers as Record<string, string> | undefined),
		},
		unix: boot.socket,
	} as never);
}

export const SCOUT = "app:agent.scout";
export const GUIDE = "app:agent.guide";
export const FCM = "https://fcm.googleapis.com/fcm/send/";

export const utcClock = (ms: number): string =>
	new Date(ms).toISOString().slice(11, 16);

export async function waitFor(
	done: () => boolean | Promise<boolean>,
	ms = 5000,
) {
	const deadline = Date.now() + ms;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await Bun.sleep(20);
	}
}
