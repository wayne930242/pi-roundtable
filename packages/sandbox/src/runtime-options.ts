import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	type BrokerOptions,
	type HostTool,
	type McpServer,
	SandboxBroker,
} from "./broker.ts";
import {
	type ContainerDriver,
	type ContainerSpec,
	containerRunArgs,
	DockerContainerDriver,
} from "./container-driver.ts";

export interface SandboxRuntimeOptions {
	image: string;
	/** Private host-only directory for ephemeral broker mounts (keep its absolute path short). */
	runRoot: string;
	/** Private directory of channel workspaces. Its root is never mounted. */
	workspaceRoot: string;
	model: string;
	modelUrl: string;
	apiKey: BrokerOptions["apiKey"];
	prompt?: string;
	timeZone?: string;
	tools?: readonly HostTool[];
	mcp?: readonly McpServer[];
	uid?: number;
	gid?: number;
	limits?: Pick<ContainerSpec, "memoryMb" | "cpus" | "pids">;
	turnTimeoutMs?: number;
	driver?: ContainerDriver;
	/** Offline tests only; production endpoints must use HTTPS. */
	allowHttp?: boolean;
}

/** Internal setup result: canonical directories, explicit identity and a selected driver. */
export interface ResolvedSandboxRuntimeOptions extends SandboxRuntimeOptions {
	uid: number;
	gid: number;
	driver: ContainerDriver;
}

/** Validates operator settings once, before any channel can claim a turn. */
export function resolveSandboxRuntimeOptions(
	options: SandboxRuntimeOptions,
): ResolvedSandboxRuntimeOptions {
	if (!options.driver && process.platform !== "linux")
		throw new Error("Docker sandbox execution requires a native Linux host");
	if (!options.model.trim()) throw new Error("model is required");
	new Intl.DateTimeFormat("en-US", { timeZone: options.timeZone ?? "UTC" });
	if (
		options.turnTimeoutMs !== undefined &&
		(!Number.isSafeInteger(options.turnTimeoutMs) ||
			options.turnTimeoutMs < 1000 ||
			options.turnTimeoutMs > 600_000)
	)
		throw new Error("turnTimeoutMs must be 1000 to 600000");
	for (const root of [options.runRoot, options.workspaceRoot]) {
		if (!isAbsolute(root) || root === "/")
			throw new Error("sandbox roots must be absolute dedicated directories");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const info = statSync(root);
		if (
			!info.isDirectory() ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o077) !== 0
		)
			throw new Error(
				"sandbox roots must be private directories owned by the service user",
			);
	}
	const runRoot = realpathSync(options.runRoot);
	const workspaceRoot = realpathSync(options.workspaceRoot);
	if (
		runRoot === workspaceRoot ||
		runRoot.startsWith(`${workspaceRoot}/`) ||
		workspaceRoot.startsWith(`${runRoot}/`)
	)
		throw new Error("sandbox roots must be separate");
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const gid = options.gid ?? process.getgid?.() ?? 0;
	if (
		uid <= 0 ||
		gid <= 0 ||
		uid !== process.getuid?.() ||
		gid !== process.getgid?.()
	)
		throw new Error(
			"run the host as a non-root user; worker uid/gid must match it",
		);
	if (runRoot.length + "/turn-XXXXXX/broker.sock".length > 100)
		throw new Error("broker socket path too long");
	containerRunArgs({
		name: "sandbox-preflight",
		image: options.image,
		runDir: runRoot,
		workspaceDir: workspaceRoot,
		uid,
		gid,
		...options.limits,
	});
	const resolved = {
		...options,
		runRoot,
		workspaceRoot,
		uid,
		gid,
		driver: options.driver ?? new DockerContainerDriver(),
	};
	// Validate broker policy at setup, not after claiming the first guest message.
	new SandboxBroker({
		...options,
		context: {
			channel: "sandbox:preflight",
			speaker: { id: "", name: "" },
			signal: new AbortController().signal,
		},
	});
	return resolved;
}
