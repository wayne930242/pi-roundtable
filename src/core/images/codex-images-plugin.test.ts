import { describe, expect, test } from "bun:test";
import { PluginError } from "../errors.ts";
import type { PluginContext } from "../plugin.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import type { CodexFetch } from "./codex-image.ts";
import { createCodexImages } from "./codex-images-plugin.ts";

/** A login token shaped like the real one, built at run time so no literal token sits in the source. */
function token(account: string): string {
	const claims = {
		"https://api.openai.com/auth": { chatgpt_account_id: account },
	};
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const PNG64 = Buffer.from(PNG).toString("base64");

/** A server-sent event stream of the given events. */
function stream(...events: unknown[]): Response {
	const text = events
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(text, {
		headers: { "content-type": "text/event-stream" },
	});
}

const drawn = {
	type: "response.output_item.done",
	item: { type: "image_generation_call", status: "completed", result: PNG64 },
};
const completed = { type: "response.completed", response: { output: [] } };

/** The part of the plugin context setup reads: the login and the logger. */
function contextOf(
	apiKey: (provider: string) => Promise<string | undefined>,
	logger = recordingLogger().logger,
): PluginContext {
	// SAFETY: setup reads only apiKey and logger.
	return { apiKey, logger } as unknown as PluginContext;
}

const loggedIn = (value: string) => contextOf(async () => value);

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error,
	);

describe("the codex-images plugin", () => {
	test("fills the images slot with the bytes Codex draws", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const secret = token("acct-1");
		const plugin = createCodexImages({
			fetch: async (url, init) => {
				requests.push({ url, init });
				return stream(drawn, completed);
			},
		});
		await plugin.setup(loggedIn(secret));
		const image = await plugin.providers?.images?.("a fox", [
			{ data: "AAAA", mimeType: "image/png" },
		]);
		expect([...(image ?? [])]).toEqual([...PNG]);
		const headers = requests[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${secret}`);
		expect(headers["chatgpt-account-id"]).toBe("acct-1");
		expect(JSON.parse(String(requests[0]?.init.body)).model).toBe("gpt-6-sol");
	});

	test("routes with the model it is given", async () => {
		let sent = "";
		const plugin = createCodexImages({
			model: "gpt-other",
			fetch: async (_url, init) => {
				sent = JSON.parse(String(init.body)).model;
				return stream(drawn, completed);
			},
		});
		await plugin.setup(loggedIn(token("acct-1")));
		await plugin.providers?.images?.("a fox", []);
		expect(sent).toBe("gpt-other");
	});

	test("reads the login again for each drawing", async () => {
		const bearers: string[] = [];
		const answers = [token("first"), token("second")];
		const plugin = createCodexImages({
			fetch: async (_url, init) => {
				bearers.push(
					(init.headers as Record<string, string>)["chatgpt-account-id"] ?? "",
				);
				return stream(drawn, completed);
			},
		});
		// Setup reads the login once; each drawing reads it again.
		const reads = [answers[0], answers[0], answers[1]];
		await plugin.setup(contextOf(async () => reads.shift()));
		await plugin.providers?.images?.("a", []);
		await plugin.providers?.images?.("b", []);
		expect(bearers).toEqual(["first", "second"]);
	});

	describe("aborting with the turn", () => {
		/** A network that keeps each request's signal and answers when it is done: never, unless told. */
		function stalled() {
			const signals: AbortSignal[] = [];
			const fetch: CodexFetch = (_url, init) => {
				const signal = init.signal as AbortSignal;
				signals.push(signal);
				return new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason));
				});
			};
			return { signals, fetch };
		}

		test("a drawing the turn aborts rejects with the turn's reason, and its request is aborted", async () => {
			const { signals, fetch } = stalled();
			const plugin = createCodexImages({ fetch });
			await plugin.setup(loggedIn(token("acct-1")));
			const turn = new AbortController();
			const reason = new Error("the turn ended");
			const drawing = failureOf(
				plugin.providers?.images?.("a fox", [], { signal: turn.signal }) ??
					Promise.resolve(),
			);
			await new Promise((done) => setTimeout(done, 20));
			expect(signals[0]?.aborted).toBe(false);
			turn.abort(reason);
			expect(await drawing).toBe(reason);
			expect(signals[0]?.aborted).toBe(true);
		});

		test("counter-proof: a drawing nobody aborts leaves its request signal unaborted", async () => {
			const signals: AbortSignal[] = [];
			const plugin = createCodexImages({
				fetch: async (_url, init) => {
					signals.push(init.signal as AbortSignal);
					return stream(drawn, completed);
				},
			});
			await plugin.setup(loggedIn(token("acct-1")));
			const turn = new AbortController();
			await plugin.providers?.images?.("a fox", [], { signal: turn.signal });
			await plugin.providers?.images?.("a fox", []);
			expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
		});
	});

	describe("without a login", () => {
		test("setup throws a PluginError that names the provider and says to log in", async () => {
			const plugin = createCodexImages();
			const failure = await failureOf(
				(async () => plugin.setup(contextOf(async () => undefined)))(),
			);
			expect(failure).toBeInstanceOf(PluginError);
			expect((failure as PluginError).message).toContain("openai-codex");
			expect((failure as PluginError).message).toContain("Log in");
		});

		test('"warn" logs one warning at setup, and a drawing then fails with the same PluginError', async () => {
			const { logger, lines } = recordingLogger();
			const plugin = createCodexImages({
				onMissingLogin: "warn",
				fetch: async () => stream(completed),
			});
			await plugin.setup(contextOf(async () => undefined, logger));
			expect(lines.map((line) => line.level)).toEqual(["warn"]);
			expect(lines[0]?.message).toContain("openai-codex");
			expect(lines[0]?.message).toContain(
				"Drawing images fails until the login exists.",
			);
			expect(lines[0]?.message).not.toContain("plugin codex-images:");
			const failure = await failureOf(
				plugin.providers?.images?.("a fox", []) ?? Promise.resolve(),
			);
			expect(failure).toBeInstanceOf(PluginError);
			expect((failure as PluginError).message).toContain("openai-codex");
		});
	});
});
