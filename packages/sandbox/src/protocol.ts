export const DUMMY_KEY = "sandbox-dummy-key";
export const BROKER_PATH = "/broker/broker.sock";
export const WORKSPACE_PATH = "/workspace";

export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface SandboxTurn {
	text: string;
	speaker: { id: string; name: string };
	model: string;
	prompt: string;
	timeZone: string;
	tools: ToolSpec[];
	reset?: boolean;
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
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new Error("body too large");
			}
			chunks.push(value);
		}
	} finally {
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
