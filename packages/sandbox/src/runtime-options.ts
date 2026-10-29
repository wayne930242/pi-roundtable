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
import { budgetsError, type SandboxBudgets } from "./protocol.ts";

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
	/**
	 * Byte limits the worker enforces (see `SandboxBudgets`); each defaults to the worker's own:
	 * 8,192 for the prompt, 4,096 for a tool result, 196,608 for a model request.
	 */
	budgets?: SandboxBudgets;
	/** Broker calls (model and host tools together) one turn may make; default 48. */
	maxCalls?: number;
	/** Output tokens one model call may produce, thinking included; default 4,096. */
	maxOutputTokens?: number;
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
	if (options.budgets !== undefined) {
		const error = budgetsError(options.budgets);
		if (error) throw new Error(error);
	}
	checkPromptBudget(options);
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
			speaker: { id: "", name: "", principalId: "" },
			signal: new AbortController().signal,
		},
	});
	return resolved;
}

/** The prompt's size as the worker measures it. */
function promptSize(text: string): number {
	return Buffer.byteLength(JSON.stringify(text));
}

/**
 * Stops startup when an operator-set `promptBytes` is smaller than the prompt: the worker would
 * cut it silently otherwise. Without that option the worker keeps its 8,192-byte cut as before.
 */
function checkPromptBudget(options: SandboxRuntimeOptions): void {
	const limit = options.budgets?.promptBytes;
	if (limit === undefined || options.prompt === undefined) return;
	const size = promptSize(options.prompt);
	if (size > limit)
		throw new Error(
			`prompt is ${size} bytes, over budgets.promptBytes ${limit}; shorten it or raise the budget`,
		);
}
