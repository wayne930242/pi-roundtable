import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	boundedText,
	isRecord,
	type SandboxReply,
	type SandboxTurn,
} from "./protocol.ts";

export interface ContainerSpec {
	name: string;
	image: string;
	runDir: string;
	workspaceDir: string;
	uid: number;
	gid: number;
	memoryMb?: number;
	cpus?: number;
	pids?: number;
	/** Runs this command instead of the image's own, such as a precheck script's runner. */
	entrypoint?: readonly string[];
	/** Mounts the workspace read-only, for a run that may write nothing to the host. */
	workspaceReadOnly?: boolean;
}
export interface ContainerDriver {
	run(
		spec: ContainerSpec,
		turn: SandboxTurn,
		signal: AbortSignal,
	): Promise<SandboxReply>;
}

/** Pure argument generation: no Docker daemon is required to test the isolation boundary. */
export function containerRunArgs(spec: ContainerSpec): string[] {
	if (
		!/^[a-z0-9][a-z0-9_.-]{0,90}$/.test(spec.name) ||
		!spec.image ||
		spec.image.startsWith("-") ||
		/\s/.test(spec.image)
	)
		throw new Error("invalid container name or image");
	if (
		!Number.isInteger(spec.uid) ||
		spec.uid <= 0 ||
		!Number.isInteger(spec.gid) ||
		spec.gid <= 0
	)
		throw new Error("sandbox requires a non-root user and group");
	for (const dir of [spec.runDir, spec.workspaceDir]) {
		if (!isAbsolute(dir) || dir === "/" || /[,\n\r]/.test(dir))
			throw new Error("mount paths must be absolute dedicated directories");
	}
	if (
		spec.runDir === spec.workspaceDir ||
		spec.runDir.startsWith(`${spec.workspaceDir}/`) ||
		spec.workspaceDir.startsWith(`${spec.runDir}/`)
	)
		throw new Error("broker and workspace mounts must be separate");
	const memory = spec.memoryMb ?? 512;
	const cpus = spec.cpus ?? 1;
	const pids = spec.pids ?? 64;
	if (
		!Number.isSafeInteger(memory) ||
		memory < 64 ||
		!Number.isFinite(cpus) ||
		cpus <= 0 ||
		!Number.isSafeInteger(pids) ||
		pids < 8
	)
		throw new Error("invalid resource limits");
	const [command, ...args] = spec.entrypoint ?? [];
	if (
		spec.entrypoint &&
		(!command ||
			spec.entrypoint.some(
				(part) => !part || part.startsWith("-") || /[\0\r\n]/.test(part),
			))
	)
		throw new Error("invalid entrypoint");
	return [
		"run",
		"--rm",
		"--interactive",
		"--sig-proxy=false",
		"--log-driver",
		"none",
		"--pull",
		"never",
		"--name",
		spec.name,
		"--network",
		"none",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--user",
		`${spec.uid}:${spec.gid}`,
		"--memory",
		`${memory}m`,
		"--memory-swap",
		`${memory}m`,
		"--cpus",
		String(cpus),
		"--pids-limit",
		String(pids),
		"--ulimit",
		"nofile=256:256",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
		"--mount",
		`type=bind,src=${spec.runDir},dst=/broker,readonly,bind-propagation=rprivate`,
		"--mount",
		`type=bind,src=${spec.workspaceDir},dst=/workspace,${spec.workspaceReadOnly ? "readonly," : ""}bind-propagation=rprivate`,
		"--env",
		"HOME=/tmp/home",
		...(command ? ["--entrypoint", command] : []),
		spec.image,
		...args,
	];
}

export class DockerContainerDriver implements ContainerDriver {
	readonly #binary: string;
	constructor(binary = "docker") {
		this.#binary = binary;
	}

	async run(
		spec: ContainerSpec,
		turn: SandboxTurn,
		signal: AbortSignal,
	): Promise<SandboxReply> {
		const output = await this.exec(spec, JSON.stringify(turn), signal, {
			stdoutBytes: 2 * 1024 * 1024,
		});
		const reply: unknown = JSON.parse(output);
		if (
			!isRecord(reply) ||
			typeof reply.ok !== "boolean" ||
			typeof reply.text !== "string" ||
			reply.text.length > 100_000
		)
			throw new Error("invalid sandbox reply");
		return { ok: reply.ok, text: reply.text };
	}

	/**
	 * Runs one sealed container with `input` on its stdin and returns its stdout, bounded; a
	 * nonzero exit or an abort throws, and the container is force-removed either way.
	 */
	async exec(
		spec: ContainerSpec,
		input: string,
		signal: AbortSignal,
		limits: { stdoutBytes: number },
	): Promise<string> {
		// Canonical paths prevent symlinks in operator configuration selecting a different mount.
		const args = containerRunArgs({
			...spec,
			runDir: realpathSync(spec.runDir),
			workspaceDir: realpathSync(spec.workspaceDir),
		});
		signal.throwIfAborted();
		const child = Bun.spawn([this.#binary, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		// SIGTERM can be proxied into an uncooperative PID 1 forever; kill this CLI directly.
		const abort = () => child.kill("SIGKILL");
		signal.addEventListener("abort", abort, { once: true });
		try {
			child.stdin.write(input);
			child.stdin.end();
			const [output, , code] = await Promise.all([
				boundedText(child.stdout, limits.stdoutBytes),
				boundedText(child.stderr, 128 * 1024),
				child.exited,
			]);
			signal.throwIfAborted();
			if (code !== 0) throw new Error("sandbox worker failed");
			return output;
		} finally {
			signal.removeEventListener("abort", abort);
			child.kill("SIGKILL");
			await child.exited;
			// Do not wait on a cooperative container exit; force-remove its exact name.
			await this.#remove(spec.name);
			if (signal.aborted || child.exitCode !== 0) {
				// Cover the short create/attach race after killing the run client.
				await Bun.sleep(100);
				await this.#remove(spec.name);
			}
		}
	}

	async #remove(name: string): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const cleanup = Bun.spawn([this.#binary, "rm", "--force", name], {
				stdout: "ignore",
				stderr: "pipe",
			});
			const timer = setTimeout(() => cleanup.kill("SIGKILL"), 5000);
			try {
				const [error, code] = await Promise.all([
					boundedText(cleanup.stderr, 16 * 1024),
					cleanup.exited,
				]);
				if (code === 0 || /No such (container|object)/i.test(error)) return;
				if (attempt === 2 || !/removal.*already in progress/is.test(error))
					throw new Error(
						"sandbox container cleanup failed; inspect this installation's containers",
					);
			} finally {
				clearTimeout(timer);
				cleanup.kill("SIGKILL");
				await cleanup.exited;
			}
			await Bun.sleep(100 * (attempt + 1));
		}
	}
}
