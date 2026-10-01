// Warning: this plugin uses ChatGPT's undocumented Codex backend, signed in with the owner's own
// ChatGPT subscription (the `openai-codex` login), to draw images. OpenAI has not published it
// as an API, so it can stop working without notice, and OpenAI's terms for the subscription
// apply to it. Use it only where you accept that risk.

import { definePlugin, PluginError, type ReferenceImage } from "pi-roundtable";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/** The Pi provider whose login pays for the images. */
const CODEX_PROVIDER = "openai-codex";
/** Routes the Codex request; the backend picks the image model itself. */
const CODEX_MODEL = "gpt-6-sol";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/**
 * Codex ran the image tool but returned no image, usually because it refused the prompt.
 * Asking again with the same prompt fails again.
 */
export class ImageNotGeneratedError extends Error {
	override name = "ImageNotGeneratedError";
}

/** The part of `fetch` the plugin uses, so a test can stand in for the network. */
export type CodexFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CodexImagesOptions {
	/** The request function; default the global `fetch`. */
	fetch?: CodexFetch;
	/** The model that routes the request; default `gpt-6-sol`. */
	model?: string;
}

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
function imageOf(value: unknown): Uint8Array | undefined {
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
	return new Uint8Array(Buffer.from(item.result, "base64"));
}

/** The frames of a server-sent event stream: the text between blank lines. */
async function* frames(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body) {
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

/** Reads the events until the response completes, and returns its one image. */
async function parseImageStream(response: Response): Promise<Uint8Array> {
	if (!response.body) throw new Error("Codex returned no body");
	let image: Uint8Array | undefined;
	for await (const frame of frames(response.body)) {
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

async function generateImage(
	prompt: string,
	references: readonly ReferenceImage[],
	token: string,
	model: string,
	fetchImpl: CodexFetch,
): Promise<Uint8Array> {
	const response = await fetchImpl(CODEX_RESPONSES_URL, {
		method: "POST",
		redirect: "error",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": chatGptAccountId(token),
			originator: "pi",
			"openai-beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model,
			store: false,
			stream: true,
			instructions:
				"You are generating bitmap image assets. For this request, call the image_generation tool exactly once. Do not answer with only text unless image generation is unavailable.",
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: prompt },
						...references.map((image) => ({
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
	return parseImageStream(response);
}

const NO_LOGIN = `the host has no login for ${CODEX_PROVIDER}, the provider that pays for the images. Log in to the ${CODEX_PROVIDER} provider with Pi so the agent directory's auth.json holds it, or remove this plugin.`;

/** The plugin, with its request function and model replaceable for a test. */
export function createCodexImages(options: CodexImagesOptions = {}) {
	const { fetch: fetchImpl = fetch, model = CODEX_MODEL } = options;
	let apiKey: ((provider: string) => Promise<string | undefined>) | undefined;
	// The login refreshes its token, so each image reads it again instead of keeping the first.
	const token = async (): Promise<string> => {
		const value = await apiKey?.(CODEX_PROVIDER);
		if (!value) throw new PluginError(`plugin codex-images: ${NO_LOGIN}`);
		return value;
	};
	return definePlugin({
		name: "codex-images",
		providers: {
			// The images slot draws an agent's avatar from a prompt and reference pictures.
			images: async (prompt, references) =>
				generateImage(prompt, references, await token(), model, fetchImpl),
		},
		async setup(context) {
			apiKey = context.apiKey;
			await token();
			return {};
		},
	});
}

export const codexImages = createCodexImages();
