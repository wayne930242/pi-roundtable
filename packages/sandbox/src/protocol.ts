export const DUMMY_KEY = "sandbox-dummy-key";
export const BROKER_PATH = "/broker/broker.sock";
export const WORKSPACE_PATH = "/workspace";
/** Where a channel's own state directory is mounted in `workspace: "server"` mode. */
export const CHANNEL_PATH = "/channel";
/** The image label naming the worker protocol version an image speaks. */
export const SANDBOX_PROTOCOL_LABEL = "pi-roundtable-sandbox.protocol";
/**
 * The worker protocol this package speaks: 2 adds `historyDir`, `budgets` and the file and skill
 * tools. An image labelled lower, or unlabelled, is an older worker.
 */
export const SANDBOX_PROTOCOL = 2;

export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/**
 * Byte budgets the sealed worker enforces, each measured as
 * `Buffer.byteLength(JSON.stringify(text))`. An absent key means the worker's default.
 */
export interface SandboxBudgets {
	/** The system prompt, including a skill index. */
	promptBytes?: number;
	/** One tool result, as the worker measures it after encoding. */
	toolResultBytes?: number;
	/** One model request; the oldest history and tool-call groups are dropped to fit. */
	requestBytes?: number;
}
export const BUDGET_DEFAULTS = {
	promptBytes: 8192,
	toolResultBytes: 4096,
	requestBytes: 196_608,
} as const satisfies Required<SandboxBudgets>;
export const BUDGET_LIMITS = {
	promptBytes: { min: 256, max: 32_768 },
	toolResultBytes: { min: 256, max: 32_768 },
	requestBytes: { min: 4096, max: 196_608 },
} as const;

/** Why `value` is not a valid budgets object, or undefined when it is one. */
export function budgetsError(value: unknown): string | undefined {
	if (!isRecord(value)) return "budgets must be an object";
	for (const name of Object.keys(value)) {
		if (!(name in BUDGET_LIMITS)) return `unknown budget ${name}`;
	}
	for (const name of Object.keys(BUDGET_LIMITS) as (keyof SandboxBudgets)[]) {
		const entry = value[name];
		if (entry === undefined) continue;
		const { min, max } = BUDGET_LIMITS[name];
		if (
			!Number.isSafeInteger(entry) ||
			(entry as number) < min ||
			(entry as number) > max
		)
			return `budgets.${name} must be an integer from ${min} to ${max}`;
	}
	return undefined;
}

/**
 * What the broker's `{"text":…}` wrapper costs a host tool's result in the worker's measure:
 * the wrapper is encoded twice, once into the broker's reply and once into the tool message.
 */
export const TOOL_RESULT_WRAPPER_BYTES = 17;

/**
 * The size of a host tool's result `text` in the worker's measure after the wrapper, to compare
 * with `HostToolContext.resultBytes`: the bytes of its text encoded twice, so a newline or a
 * quote costs four.
 */
export function toolResultTextBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(JSON.stringify(text))) - 2;
}

/** The workspace file tools' limits, as the turn carries them. */
export interface SandboxFiles {
	/** The most UTF-8 bytes one file may hold. */
	maxFileBytes: number;
	/** The most bytes everything under `files/` may hold. */
	maxTotalBytes: number;
}
export const FILES_DIR = "files";
export const FILES_DEFAULTS = {
	maxFileBytes: 256 * 1024,
	maxTotalBytes: 32 * 1024 * 1024,
} as const satisfies SandboxFiles;
const FILES_FILE_CEILING = 16 * 1024 * 1024;
const FILES_TOTAL_CEILING = 100 * 1024 ** 3;

/** Why `value` is not a valid files limit pair, or undefined when it is one. */
export function filesError(value: unknown): string | undefined {
	if (!isRecord(value)) return "files must be an object of limits";
	const { maxFileBytes, maxTotalBytes } = value;
	if (
		!Number.isSafeInteger(maxFileBytes) ||
		(maxFileBytes as number) < 1 ||
		(maxFileBytes as number) > FILES_FILE_CEILING
	)
		return `files.maxFileBytes must be an integer from 1 to ${FILES_FILE_CEILING}`;
	if (
		!Number.isSafeInteger(maxTotalBytes) ||
		(maxTotalBytes as number) < 1 ||
		(maxTotalBytes as number) > FILES_TOTAL_CEILING
	)
		return `files.maxTotalBytes must be an integer from 1 to ${FILES_TOTAL_CEILING}`;
	if ((maxFileBytes as number) > (maxTotalBytes as number))
		return "files.maxFileBytes must not exceed files.maxTotalBytes";
	return undefined;
}

export interface SandboxTurn {
	text: string;
	speaker: { id: string; name: string };
	model: string;
	prompt: string;
	timeZone: string;
	tools: ToolSpec[];
	reset?: boolean;
	/** Absent unless the operator set a budget; the worker then keeps its defaults. */
	budgets?: SandboxBudgets;
	/** Present when the file tools are on; absent means the worker offers none. */
	files?: SandboxFiles;
	/** Where the history file lives; absent means in the workspace, as before. */
	historyDir?: typeof CHANNEL_PATH;
	mcp: { server: string; tools: ToolSpec[] }[];
}

export interface SandboxReply {
	ok: boolean;
	text: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolSpec(value: unknown): value is ToolSpec {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		validName(value.name) &&
		typeof value.description === "string" &&
		isRecord(value.parameters)
	);
}

export function isSandboxTurn(value: unknown): value is SandboxTurn {
	return (
		isRecord(value) &&
		typeof value.text === "string" &&
		isRecord(value.speaker) &&
		typeof value.speaker.id === "string" &&
		typeof value.speaker.name === "string" &&
		typeof value.model === "string" &&
		typeof value.prompt === "string" &&
		typeof value.timeZone === "string" &&
		(value.reset === undefined || typeof value.reset === "boolean") &&
		(value.budgets === undefined ||
			budgetsError(value.budgets) === undefined) &&
		(value.historyDir === undefined || value.historyDir === CHANNEL_PATH) &&
		(value.files === undefined || filesError(value.files) === undefined) &&
		Array.isArray(value.tools) &&
		value.tools.every(isToolSpec) &&
		Array.isArray(value.mcp) &&
		value.mcp.every(
			(server) =>
				isRecord(server) &&
				typeof server.server === "string" &&
				validName(server.server) &&
				Array.isArray(server.tools) &&
				server.tools.every(isToolSpec),
		)
	);
}

export function validName(value: string): boolean {
	return /^[a-z][a-z0-9_]{0,47}$/.test(value);
}

export function validFunctionName(name: unknown): name is string {
	return typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name);
}

export function validCallId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id.length <= 128;
}

/** Bound untrusted input before JSON parsing, including chunked bodies. */
export async function boundedText(
	stream: ReadableStream<Uint8Array> | null,
	limit: number,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	if (!stream) return "";
	const reader = stream.getReader();
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new Error("body too large");
			}
			chunks.push(value);
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(data);
}
