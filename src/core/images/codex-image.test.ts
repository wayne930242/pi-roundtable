import { afterEach, describe, expect, test } from "bun:test";
import {
	CODEX_IMAGE_LIMITS,
	CODEX_IMAGE_MODEL,
	type CodexFetch,
	type CodexImageRequest,
	drawCodexImage,
	ImageNotGeneratedError,
	requestCodexImage,
} from "./codex-image.ts";

/** A login token shaped like the real one, built at run time so no literal token sits in the source. */
function token(account = "acct-1"): string {
	const claims = {
		"https://api.openai.com/auth": { chatgpt_account_id: account },
	};
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const PNG64 = Buffer.from(PNG).toString("base64");
const SSE = { "content-type": "text/event-stream" };

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/** A server-sent event stream of the given events. */
function stream(...events: unknown[]): Response {
	return new Response(events.map(frame).join(""), { headers: SSE });
}

const drawn = (result: string, status = "completed", extra = {}) => ({
	type: "response.output_item.done",
	item: { type: "image_generation_call", status, result, ...extra },
});
const completed = { type: "response.completed", response: { output: [] } };

const answering =
	(answer: () => Response): CodexFetch =>
	async () =>
		answer();

const draw = (answer: () => Response, extra: Partial<CodexImageRequest> = {}) =>
	drawCodexImage({
		token: token(),
		prompt: "a fox",
		fetch: answering(answer),
		...extra,
	});

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error as Error,
	);

describe("the stream", () => {
	test("reads the image and its revised prompt from the item event, and from the completed output", async () => {
		const fromItem = await draw(() =>
			stream(
				drawn(PNG64, "completed", { revised_prompt: "a red fox" }),
				completed,
			),
		);
		expect([...fromItem.data]).toEqual([...PNG]);
		expect(fromItem.revisedPrompt).toBe("a red fox");

		const fromOutput = await draw(() =>
			stream({
				type: "response.completed",
				response: {
					output: [
						{ type: "message" },
						{
							type: "image_generation_call",
							status: "completed",
							result: PNG64,
						},
					],
				},
			}),
		);
		expect([...fromOutput.data]).toEqual([...PNG]);
		expect("revisedPrompt" in fromOutput).toBe(false);
	});

	test("takes the first image and stops reading after the response completes", async () => {
		const other = Buffer.from([1, 2, 3]).toString("base64");
		const text = `${frame(drawn(PNG64))}${frame(drawn(other))}${frame(completed)}data: {not json\n\n`;
		const image = await draw(() => new Response(text, { headers: SSE }));
		expect([...image.data]).toEqual([...PNG]);
	});

	test("joins data lines, accepts CRLF frames, and ignores [DONE] and frames without data", async () => {
		const json = JSON.stringify(drawn(PNG64));
		const cut = json.indexOf(',"item"');
		const split = `event: x\r\ndata: ${json.slice(0, cut)}\r\ndata: ${json.slice(cut)}\r\n\r\n`;
		const text = `: ping\n\n${split}data: [DONE]\n\n${frame(completed)}`;
		const image = await draw(() => new Response(text, { headers: SSE }));
		expect([...image.data]).toEqual([...PNG]);
	});

	test("reads a final frame the stream ends without a blank line after", async () => {
		const text = `${frame(drawn(PNG64))}data: ${JSON.stringify(completed)}`;
		const image = await draw(() => new Response(text, { headers: SSE }));
		expect([...image.data]).toEqual([...PNG]);
	});
});

describe("the request", () => {
	test("sends the login, the account from its claims, the prompt and the references as data URLs", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const secret = token("acct-9");
		await drawCodexImage({
			token: secret,
			prompt: "a fox",
			references: [{ data: "AAAA", mimeType: "image/png" }],
			fetch: async (url, init) => {
				requests.push({ url, init });
				return stream(drawn(PNG64), completed);
			},
		});
		const [request] = requests;
		expect(request?.url).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(request?.init.method).toBe("POST");
		expect(request?.init.redirect).toBe("error");
		const headers = request?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${secret}`);
		expect(headers["chatgpt-account-id"]).toBe("acct-9");
		expect(headers.originator).toBe("pi");
		const body = JSON.parse(String(request?.init.body));
		expect(body.model).toBe(CODEX_IMAGE_MODEL);
		expect(body.tools).toEqual([
			{ type: "image_generation", output_format: "png" },
		]);
		expect(body.input[0].content).toEqual([
			{ type: "input_text", text: "a fox" },
			{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
		]);
	});

	test("routes with the model it is given", async () => {
		let sent = "";
		await draw(() => stream(drawn(PNG64), completed), {
			model: "gpt-other",
			fetch: async (_url, init) => {
				sent = JSON.parse(String(init.body)).model;
				return stream(drawn(PNG64), completed);
			},
		});
		expect(sent).toBe("gpt-other");
	});

	test("refuses a token that is not a JWT with account claims, before any request", async () => {
		let requests = 0;
		const fetch: CodexFetch = async () => {
			requests++;
			return stream(completed);
		};
		const bad = (value: string) =>
			failureOf(drawCodexImage({ token: value, prompt: "x", fetch }));
		const notJson = `h.${Buffer.from("nope").toString("base64url")}.s`;
		const noAccount = `h.${Buffer.from("{}").toString("base64url")}.s`;
		expect((await bad("plain"))?.message).toBe("the Codex token is not a JWT");
		expect((await bad(notJson))?.message).toBe(
			"the Codex token's claims are not JSON",
		);
		expect((await bad(noAccount))?.message).toBe(
			"the Codex token has no ChatGPT account",
		);
		expect(requests).toBe(0);
	});
});

describe("the errors", () => {
	test("an HTTP error carries its status and a body cut at 300 characters, never the token", async () => {
		const secret = token();
		const limited = await failureOf(
			draw(() => new Response("rate limited", { status: 429 }), {
				token: secret,
			}),
		);
		expect(limited?.message).toBe("Codex answered 429: rate limited");
		expect(limited?.message).not.toContain(secret);
		const long = await failureOf(
			draw(() => new Response("x".repeat(900), { status: 500 })),
		);
		expect(long?.message).toBe(`Codex answered 500: ${"x".repeat(300)}`);
	});

	test.each([
		[
			"an error event",
			{ type: "error", error: { message: "boom" } },
			"Codex failed: boom",
		],
		[
			"a failed response",
			{ type: "response.failed", response: { error: { code: "quota" } } },
			"Codex failed: quota",
		],
		[
			"a failure without a reason",
			{ type: "response.failed" },
			"Codex failed: unknown error",
		],
		[
			"an incomplete response",
			{ type: "response.incomplete" },
			"the Codex response was incomplete",
		],
	])("%s fails with its message", async (_name, event, message) => {
		const failure = await failureOf(draw(() => stream(event)));
		expect(failure?.message).toBe(message);
		expect(failure).not.toBeInstanceOf(ImageNotGeneratedError);
	});

	test("a stream that ends early, has no body or sends a malformed event fails", async () => {
		expect((await failureOf(draw(() => stream(drawn(PNG64)))))?.message).toBe(
			"the Codex stream ended before completion",
		);
		const noBody = await failureOf(
			draw(() => ({ ok: true, body: null }) as Response),
		);
		expect(noBody?.message).toBe("Codex returned no body");
		const malformed = await failureOf(
			draw(() => new Response("data: {oops\n\n", { headers: SSE })),
		);
		expect(malformed?.message).toBe("Codex sent a malformed event: {oops");
	});

	test("an image call that did not complete, and a completion without an image, are ImageNotGeneratedError", async () => {
		const refused = await failureOf(
			draw(() => stream(drawn("", "failed"), completed)),
		);
		expect(refused).toBeInstanceOf(ImageNotGeneratedError);
		expect(refused?.message).toContain(
			"Codex image generation did not complete (status failed)",
		);
		const silent = await failureOf(draw(() => stream(completed)));
		expect(silent).toBeInstanceOf(ImageNotGeneratedError);
		expect(silent?.message).toBe("Codex answered without an image");
	});

	test("the not-completed detail is cut at 300 characters and leaves the result out", async () => {
		const planted = "PLANTED-RESULT-BYTES";
		const failure = await failureOf(
			draw(() =>
				stream(
					{
						type: "response.output_item.done",
						item: {
							type: "image_generation_call",
							status: "failed",
							result: planted,
							error: "content_policy",
							pad: "y".repeat(900),
						},
					},
					completed,
				),
			),
		);
		expect(failure?.message).toContain("content_policy");
		expect(failure?.message).not.toContain(planted);
		const detail = failure?.message.split("): ")[1] ?? "";
		expect(detail.length).toBe(300);
		// Counter-proof: a result string that is not empty and whose call completed is the image, not a detail.
		const image = await draw(() => stream(drawn(PNG64), completed));
		expect(image.data.byteLength).toBe(PNG.byteLength);
	});

	test("an image over 32 MiB of bytes in base64 is refused", async () => {
		const huge = "A".repeat(Math.ceil((32 * 1024 * 1024) / 3) * 4 + 4);
		// The stream cap would stop a stream this large first, so the image check runs with it lifted.
		const failure = await failureOf(
			requestCodexImage(
				{
					token: token(),
					prompt: "a fox",
					fetch: answering(() => stream(drawn(huge), completed)),
				},
				{ timeoutMs: 300_000, maxStreamBytes: 128 * 1024 * 1024 },
			),
		);
		expect(failure?.message).toBe("the image exceeds 32 MiB");
	});
});

describe("the stream cap", () => {
	const limits = { timeoutMs: 300_000, maxStreamBytes: 1024 };
	const padding = { type: "response.in_progress", pad: "p".repeat(2000) };

	test("a stream over the cap is refused, and the same image without the padding resolves", async () => {
		const request = (response: Response): CodexImageRequest => ({
			token: token(),
			prompt: "a fox",
			fetch: async () => response,
		});
		const failure = await failureOf(
			requestCodexImage(
				request(stream(padding, drawn(PNG64), completed)),
				limits,
			),
		);
		expect(failure?.message).toBe("Codex image response too large");
		const image = await requestCodexImage(
			request(stream(drawn(PNG64), completed)),
			limits,
		);
		expect([...image.data]).toEqual([...PNG]);
	});

	test("the public client uses a five-minute limit and a 32 MiB cap", () => {
		expect(CODEX_IMAGE_LIMITS).toEqual({
			timeoutMs: 300_000,
			maxStreamBytes: 32 * 1024 * 1024,
		});
	});
});

describe("aborting, against a real server", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];
	afterEach(() => {
		for (const server of servers.splice(0)) server.stop(true);
	});

	/** A server that sends headers and one frame, then either stalls or finishes the stream. */
	function serve(finish: boolean) {
		const state = { requests: 0, responded: false };
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				state.requests++;
				const encoder = new TextEncoder();
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								encoder.encode(frame({ type: "response.created" })),
							);
							if (!finish) return;
							controller.enqueue(encoder.encode(frame(drawn(PNG64))));
							controller.enqueue(encoder.encode(frame(completed)));
							controller.close();
						},
					}),
					{ headers: SSE },
				);
			},
		});
		servers.push(server);
		const over: CodexFetch = async (_url, init) => {
			const response = await fetch(`http://127.0.0.1:${server.port}/`, init);
			state.responded = true;
			return response;
		};
		return { state, over };
	}

	const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

	test("the caller's signal rejects a drawing whose headers arrived, with its own reason", async () => {
		const { state, over } = serve(false);
		const controller = new AbortController();
		const reason = new Error("the turn was cancelled");
		const drawing = failureOf(
			drawCodexImage({
				token: token(),
				prompt: "a fox",
				fetch: over,
				signal: controller.signal,
			}),
		);
		await settle(150);
		expect(state.responded).toBe(true);
		controller.abort(reason);
		expect(await drawing).toBe(reason);
	});

	test("counter-proof: the same server finishing the stream resolves without an abort", async () => {
		const { over } = serve(true);
		const image = await drawCodexImage({
			token: token(),
			prompt: "a fox",
			fetch: over,
			signal: new AbortController().signal,
		});
		expect([...image.data]).toEqual([...PNG]);
	});

	test("a signal already aborted rejects before any request reaches the server", async () => {
		const { state, over } = serve(true);
		const reason = new Error("already cancelled");
		const failure = await failureOf(
			drawCodexImage({
				token: token(),
				prompt: "a fox",
				fetch: over,
				signal: AbortSignal.abort(reason),
			}),
		);
		expect(failure).toBe(reason);
		await settle(50);
		expect(state.requests).toBe(0);
	});

	test("the time limit alone stops a stalled stream with a TimeoutError", async () => {
		const { state, over } = serve(false);
		const failure = await failureOf(
			requestCodexImage(
				{ token: token(), prompt: "a fox", fetch: over },
				{ timeoutMs: 50, maxStreamBytes: 1024 },
			),
		);
		expect(failure?.name).toBe("TimeoutError");
		expect(state.responded).toBe(true);
	});

	test("counter-proof: a finishing stream resolves inside the same short limit", async () => {
		const { over } = serve(true);
		const image = await requestCodexImage(
			{ token: token(), prompt: "a fox", fetch: over },
			{ timeoutMs: 2000, maxStreamBytes: 1024 },
		);
		expect([...image.data]).toEqual([...PNG]);
	});
});
