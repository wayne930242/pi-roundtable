import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import {
	budgetsError,
	FILES_DEFAULTS,
	filesError,
	SANDBOX_PROTOCOL,
	type SandboxBudgets,
	type SandboxFiles,
} from "./protocol.ts";

export interface SandboxRuntimeOptions {
	image: string;
	/** Private host-only directory for ephemeral broker mounts (keep its absolute path short). */
	runRoot: string;
	/** Private directory of channel workspaces. Its root is never mounted. */
	workspaceRoot: string;
	/**
	 * `"channel"` (default): one workspace per channel. `"server"`: every sandbox channel of one
	 * guild shares one workspace (memory notes, workspace files), while each channel keeps its own
	 * conversation history in a state directory mounted at `/channel`. A channel whose message
	 * carries no guild keeps its own workspace. Needs a worker image of protocol 2.
	 */
	workspace?: "channel" | "server";
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
	/**
	 * Workspace file tools in the sealed worker (`files_list`, `files_read`, `files_write`,
	 * `files_delete`) under `files/` of the workspace: `true` for the defaults, 256 KiB per file
	 * and 32 MiB in all, or limits. Shared by every channel of a `"server"` workspace. They are
	 * bounded in the worker only; keep a filesystem quota on the workspace root.
	 */
	files?: boolean | { maxFileBytes?: number; maxTotalBytes?: number };
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
	if (
		options.workspace !== undefined &&
		options.workspace !== "channel" &&
		options.workspace !== "server"
	)
		throw new Error('workspace must be "channel" or "server"');
	if (options.budgets !== undefined) {
		const error = budgetsError(options.budgets);
		if (error) throw new Error(error);
	}
	checkPromptBudget(options);
	resolveFiles(options.files);
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
	// The directories of a "server" turn are siblings under the root; prove they stay separate.
	if (options.workspace === "server")
		containerRunArgs({
			name: "sandbox-preflight",
			image: options.image,
			runDir: join(runRoot, "turn-x"),
			workspaceDir: join(workspaceRoot, "guild-x"),
			channelDir: join(workspaceRoot, "state-x"),
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

/** The worker protocol the operator's options need, or undefined when any image will do. */
export function requiredProtocol(
	options: SandboxRuntimeOptions,
): { version: number; because: string } | undefined {
	const because = [
		options.workspace === "server" ? 'workspace: "server"' : undefined,
		options.budgets ? "budgets" : undefined,
		options.files ? "files" : undefined,
		(options as { skills?: readonly unknown[] }).skills?.length
			? "skills"
			: undefined,
	].filter((name) => name !== undefined);
	return because.length
		? { version: SANDBOX_PROTOCOL, because: because.join(", ") }
		: undefined;
}

/**
 * Stops startup when an option needs a newer worker than the image is: an old worker would
 * ignore the new turn fields, and could write a channel's history into a shared workspace.
 */
export async function checkImageProtocol(
	options: ResolvedSandboxRuntimeOptions,
): Promise<void> {
	const required = requiredProtocol(options);
	if (!required) return;
	if (!options.driver.imageProtocol)
		throw new Error(
			`${required.because} needs a worker image of protocol ${required.version}, and this container driver cannot report the image's protocol`,
		);
	const found = await options.driver.imageProtocol(options.image);
	if (found === undefined || found < required.version)
		throw new Error(
			`sandbox image ${options.image} is ${found === undefined ? "unlabelled (an older worker)" : `protocol ${found}`}, but ${required.because} needs protocol ${required.version}; rebuild the image from packages/sandbox/worker/Dockerfile`,
		);
}

/** The limits `files` asks for, or undefined when the file tools are off; throws on bad limits. */
export function resolveFiles(
	files: SandboxRuntimeOptions["files"],
): SandboxFiles | undefined {
	if (files === undefined || files === false) return undefined;
	const limits = { ...FILES_DEFAULTS, ...(files === true ? {} : files) };
	const error = filesError(limits);
	if (error) throw new Error(error);
	return limits;
}
