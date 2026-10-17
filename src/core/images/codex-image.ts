// A client for ChatGPT's undocumented Codex backend, signed in with an openai-codex login, that draws one image.

import type { ReferenceImage } from "../contract/providers.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** The Pi provider whose login pays for the images. */
export const CODEX_IMAGES_PROVIDER = "openai-codex";
/** Routes the Codex request; the backend picks the image model itself. */
export const CODEX_IMAGE_MODEL = "gpt-6-sol";

/**
 * Codex ran the image tool but returned no image, or answered without one; usually it refused
 * the prompt. Asking again with the same prompt fails again.
 */
export class ImageNotGeneratedError extends Error {
	override name = "ImageNotGeneratedError";
}

/** The part of `fetch` the client uses, so a test can stand in for the network. `typeof fetch` is assignable. */
export type CodexFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CodexImageRequest {
	/** The openai-codex login's access token; read it again for each drawing, because the login refreshes. */
	token: string;
	prompt: string;
	references?: readonly ReferenceImage[];
	/** The model that routes the request; default `CODEX_IMAGE_MODEL`. */
	model?: string;
	/** Aborts the request and the read of its stream; the five-minute limit applies as well. */
	signal?: AbortSignal;
	/** The request function; default the global `fetch`. */
	fetch?: CodexFetch;
}

export interface CodexImage {
	/** PNG bytes. */
	data: Uint8Array;
	/** The prompt Codex says it drew, when it tells. */
	revisedPrompt?: string;
}

/** What bounds one drawing; the core's tests lower these, the public client always uses the defaults. */
export interface CodexImageLimits {
	timeoutMs: number;
	maxStreamBytes: number;
}

export const CODEX_IMAGE_LIMITS: CodexImageLimits = {
	timeoutMs: REQUEST_TIMEOUT_MS,
	maxStreamBytes: MAX_IMAGE_BYTES,
};

/** The ChatGPT account the login token belongs to, from the token's claims. */
function chatGptAccountId(token: string): string {
	const [, payload] = token.split(".");
	if (!payload) throw new Error("the Codex token is not a JWT");
	let claims: Record<string, unknown>;
	try {
		claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		throw new Error("the Codex token's claims are not JSON");
	}
	const auth = claims[JWT_CLAIM_PATH] as
		| { chatgpt_account_id?: unknown }
		| undefined;
	const id = auth?.chatgpt_account_id;
	if (typeof id !== "string" || !id)
		throw new Error("the Codex token has no ChatGPT account");
	return id;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** The one image an `image_generation_call` item carries; anything else is not an image. */
function imageOf(value: unknown): CodexImage | undefined {
	const item = object(value);
	if (item.type !== "image_generation_call") return undefined;
	if (
		item.status !== "completed" ||
		typeof item.result !== "string" ||
		!item.result
	) {
		const { result: _result, ...detail } = item;
		throw new ImageNotGeneratedError(
			`Codex image generation did not complete (status ${String(item.status)}): ${JSON.stringify(detail).slice(0, 300)}`,
		);
	}
	if (item.result.length > MAX_IMAGE_BASE64)
		throw new Error("the image exceeds 32 MiB");
	const data = new Uint8Array(Buffer.from(item.result, "base64"));
	return typeof item.revised_prompt === "string" && item.revised_prompt
		? { data, revisedPrompt: item.revised_prompt }
		: { data };
}

/** The frames of a server-sent event stream: the text between blank lines. */
async function* frames(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	maxBytes: number,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	let read = 0;
	for await (const chunk of body) {
		signal.throwIfAborted();
		read += chunk.byteLength;
		if (read > maxBytes) throw new Error("Codex image response too large");
		buffer += decoder.decode(chunk, { stream: true });
		let match = /\r?\n\r?\n/.exec(buffer);
		while (match) {
			yield buffer.slice(0, match.index);
			buffer = buffer.slice(match.index + match[0].length);
			match = /\r?\n\r?\n/.exec(buffer);
		}
	}
	if (buffer.trim()) yield buffer;
}

/** The event a frame carries, or undefined for a frame without data. */
function eventOf(frame: string): Record<string, unknown> | undefined {
	const data = frame
		.split(/\r?\n/)
		.flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trim()] : []))
		.join("\n");
	if (!data || data === "[DONE]") return undefined;
	try {
		return object(JSON.parse(data));
	} catch {
		throw new Error(`Codex sent a malformed event: ${data.slice(0, 200)}`);
	}
}

/** Reads the events until the response completes, and returns its first image. */
async function parseImageStream(
	response: Response,
	signal: AbortSignal,
	maxBytes: number,
): Promise<CodexImage> {
	if (!response.body) throw new Error("Codex returned no body");
	let image: CodexImage | undefined;
	for await (const frame of frames(response.body, signal, maxBytes)) {
		const event = eventOf(frame);
		switch (event?.type) {
			case "error":
			case "response.failed": {
				const error = object(object(event.response).error ?? event.error);
				throw new Error(
					`Codex failed: ${String(error.message ?? error.code ?? "unknown error")}`,
				);
			}
			case "response.incomplete":
				throw new Error("the Codex response was incomplete");
			case "response.output_item.done":
				image ??= imageOf(event.item);
				break;
			case "response.completed": {
				const output = object(event.response).output;
				if (Array.isArray(output))
					for (const item of output) image ??= imageOf(item);
				if (!image)
					throw new ImageNotGeneratedError("Codex answered without an image");
				return image;
			}
			default:
				break;
		}
	}
	throw new Error("the Codex stream ended before completion");
}

async function send(
	request: CodexImageRequest,
	signal: AbortSignal,
	maxBytes: number,
): Promise<CodexImage> {
	const fetchImpl = request.fetch ?? fetch;
	const response = await fetchImpl(CODEX_RESPONSES_URL, {
		method: "POST",
		redirect: "error",
		signal,
		headers: {
			authorization: `Bearer ${request.token}`,
			"chatgpt-account-id": chatGptAccountId(request.token),
			originator: "pi",
			"openai-beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: request.model ?? CODEX_IMAGE_MODEL,
			store: false,
			stream: true,
			instructions:
				"You are generating bitmap image assets. For this request, call the image_generation tool exactly once. Do not answer with only text unless image generation is unavailable.",
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: request.prompt },
						...(request.references ?? []).map((image) => ({
							type: "input_image",
							image_url: `data:${image.mimeType};base64,${image.data}`,
						})),
					],
				},
			],
			tools: [{ type: "image_generation", output_format: "png" }],
			tool_choice: "auto",
			parallel_tool_calls: false,
			text: { verbosity: "low" },
		}),
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(`Codex answered ${response.status}: ${detail}`);
	}
	return parseImageStream(response, signal, maxBytes);
}

/** `drawCodexImage` with its limits given, for the core's tests. */
export async function requestCodexImage(
	request: CodexImageRequest,
	limits: CodexImageLimits,
): Promise<CodexImage> {
	const timeout = AbortSignal.timeout(limits.timeoutMs);
	const signal = request.signal
		? AbortSignal.any([request.signal, timeout])
		: timeout;
	signal.throwIfAborted();
	try {
		return await send(request, signal, limits.maxStreamBytes);
	} catch (error) {
		// The abort reaches the caller as its own reason, not as whatever the stream wrapped it in.
		if (signal.aborted) throw signal.reason;
		throw error;
	}
}

/**
 * Draws one image through the Codex backend. It aborts with `request.signal`, before the response
 * and while its stream is read, stops after five minutes, and refuses a stream over 32 MiB.
 */
export function drawCodexImage(
	request: CodexImageRequest,
): Promise<CodexImage> {
	return requestCodexImage(request, CODEX_IMAGE_LIMITS);
}
