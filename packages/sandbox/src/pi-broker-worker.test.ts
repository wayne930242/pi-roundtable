import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenBroker } from "./broker.ts";
import { PiSandboxBroker } from "./pi-broker.ts";
import { piModelInput } from "./pi-model-input.ts";
import {
	PI_MEDIA_LIMITS,
	type PiThinkingLevel,
	validateImages,
	validateReplyFiles,
} from "./pi-protocol.ts";
import { bound, message, post } from "./testing/pi-broker-fixture.ts";

test("worker long polling carries host turns and bounded replies without any host connection to guest sockets or paths", async () => {
	const broker = new PiSandboxBroker({
		model: "model",
		oauthToken: () => "host-secret",
	});
	expect((await broker.handle(post("/worker/ready", {}))).status).toBe(200);
	expect(broker.isReady()).toBe(true);
	const next = broker.handle(new Request("http://broker/worker/next"));
	const { controller, release } = bound(broker);
	const request = {
		turnId: "m1",
		author: { id: "host-bound", name: "Guest" },
		text: "hello",
		memory: "channel memory",
		memoryVisibility: "shared" as const,
		images: [],
		thinking: "low" as const,
	};
	const done = broker.execute(request, controller.signal);
	expect(await (await next).json()).toEqual(request);
	expect(
		(
			await broker.handle(
				post("/worker/result", {
					turnId: "other",
					result: { ok: true, text: "spoof", files: [] },
				}),
			)
		).status,
	).toBe(409);
	expect(
		(
			await broker.handle(
				post("/worker/result", {
					turnId: "m1",
					result: {
						ok: true,
						text: "done",
						files: [{ name: "art.png", data: "AQID" }],
					},
				}),
			)
		).status,
	).toBe(200);
	expect(await done).toEqual({
		ok: true,
		text: "done",
		files: [{ name: "art.png", data: "AQID" }],
	});
	const cancelled = broker.execute(
		{ ...request, turnId: "m2" },
		controller.signal,
	);
	controller.abort();
	await expect(cancelled).rejects.toThrow("cancelled");
	release();
});

test("broker rejects credential reflection spanning stream chunks", async () => {
	const broker = new PiSandboxBroker({
		model: "model",
		oauthToken: () => "host-secret",
		fetchImpl: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(Buffer.from("host-"));
						controller.enqueue(Buffer.from("secret"));
						controller.close();
					},
				}),
			),
	});
	const { release } = bound(broker);
	const response = await broker.handle(post("/anthropic/v1/messages", message));
	await expect(response.text()).rejects.toThrow();
	release();
});

test("bridge-shaped SSE, count_tokens and xhigh/adaptive thinking retain valid output budgets", async () => {
	const inputs: Record<string, unknown>[] = [];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		fetchImpl: async (url, init) => {
			inputs.push(JSON.parse(String(init.body)));
			return url.includes("count_tokens")
				? Response.json({ input_tokens: 123 })
				: new Response(
						'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
						{ headers: { "content-type": "text/event-stream" } },
					);
		},
	});
	const { release } = bound(broker);
	// The worker's request sits under the "xhigh" ceiling here; a lower host level is tested separately.
	const extended = {
		...message,
		max_tokens: 64_000,
		thinking: { type: "enabled", budget_tokens: 32_000 },
		stream: true,
	};
	const response = await broker.handle(
		post("/anthropic/v1/messages?beta=true", extended),
	);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	expect(await response.text()).toContain('"message_stop"');
	expect(inputs[0]).toMatchObject({
		max_tokens: 64_000,
		thinking: { type: "enabled", budget_tokens: 32_000 },
		stream: true,
	});
	await broker.handle(
		post("/anthropic/v1/messages", {
			...extended,
			thinking: { type: "adaptive" },
			output_config: { effort: "max" },
		}),
	);
	expect(inputs[1]).toMatchObject({
		thinking: { type: "adaptive" },
		output_config: { effort: "max" },
	});
	const count = await broker.handle(
		post("/anthropic/v1/messages/count_tokens", message),
	);
	expect(await count.json()).toEqual({ input_tokens: 123 });
	expect(inputs[2]).not.toHaveProperty("max_tokens");
	const clamped = piModelInput(
		{ ...extended, max_tokens: 8192 },
		"host",
		false,
		128_000,
		"xhigh",
	);
	expect(Number(clamped.max_tokens)).toBeGreaterThan(32_000);
	release();
});

test("only one active reply packet is read and cancellation releases its reader", async () => {
	const broker = new PiSandboxBroker({
		model: "model",
		oauthToken: () => "host-secret",
	});
	expect((await broker.handle(post("/worker/result", {}))).status).toBe(409);
	const { controller, release } = bound(broker);
	const answer = broker.execute(
		{
			turnId: "turn",
			author: { id: "guest", name: "Guest" },
			text: "text",
			memory: "",
			thinking: "low",
			images: [],
		},
		controller.signal,
	);
	const failed = answer.catch((error: unknown) => String(error));
	await broker.handle(new Request("http://broker/worker/next"));
	let cancelled = false;
	const packet = broker.handle(
		new Request("http://broker/worker/result", {
			method: "POST",
			body: new ReadableStream<Uint8Array>(
				{
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			),
		}),
	);
	await Promise.resolve();
	expect((await broker.handle(post("/worker/result", {}))).status).toBe(429);
	controller.abort();
	expect(await failed).toContain("cancelled");
	expect((await packet).status).toBe(400);
	expect(cancelled).toBe(true);
	release();
});

test("media/file count, base64, traversal and byte bounds are enforced", () => {
	expect(() =>
		validateImages([{ data: "AQID", mimeType: "image/png" }]),
	).not.toThrow();
	for (const images of [
		Array(PI_MEDIA_LIMITS.images + 1).fill({
			data: "AQID",
			mimeType: "image/png",
		}),
		[{ data: "bad%", mimeType: "image/png" }],
		[{ data: "AQID", mimeType: "text/plain" }],
	])
		expect(() => validateImages(images)).toThrow();
	for (const files of [
		[{ name: "../owner", data: "AQID" }],
		[{ name: "image.png", data: "bad%" }],
		Array(11).fill({ name: "image.png", data: "AQID" }),
		[
			{
				name: "image.png",
				data: Buffer.alloc(PI_MEDIA_LIMITS.fileBytes + 1).toString("base64"),
			},
		],
	])
		expect(() => validateReplyFiles(files)).toThrow();
});

test("the worker cannot raise effort or thinking budget above the host-judged level", () => {
	const ask = (thinking: PiThinkingLevel, extra: Record<string, unknown>) =>
		piModelInput({ ...message, ...extra }, "host", false, 128_000, thinking);
	expect(
		ask("low", {
			thinking: { type: "adaptive" },
			output_config: { effort: "max" },
		}).output_config,
	).toEqual({ effort: "low" });
	expect(
		ask("medium", {
			thinking: { type: "adaptive" },
			output_config: { effort: "xhigh" },
		}).output_config,
	).toEqual({ effort: "medium" });
	expect(
		ask("xhigh", {
			thinking: { type: "adaptive" },
			output_config: { effort: "xhigh" },
		}).output_config,
	).toEqual({ effort: "xhigh" });
	// A lower request is kept, and adaptive thinking without effort is capped below the default.
	expect(
		ask("high", { output_config: { effort: "low" } }).output_config,
	).toEqual({ effort: "low" });
	expect(ask("low", { thinking: { type: "adaptive" } }).output_config).toEqual({
		effort: "low",
	});
	expect(ask("high", { thinking: { type: "adaptive" } })).not.toHaveProperty(
		"output_config",
	);
	expect(
		ask("medium", {
			thinking: { type: "enabled", budget_tokens: 120_000 },
		}).thinking,
	).toEqual({ type: "enabled", budget_tokens: 8192 });
});

test("the Unix listener streams a long model call without a fixed total cap", async () => {
	const socket = join(mkdtempSync(join(tmpdir(), "rt-stream-")), "s");
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const listener = await listenBroker(
		socket,
		async () =>
			new Response(
				new ReadableStream({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("first"));
						await gate;
						// Each gap is under the idle limit, the total is well over it.
						for (let index = 0; index < 4; index++) {
							await new Promise((resolve) => setTimeout(resolve, 150));
							controller.enqueue(new TextEncoder().encode("x"));
						}
						controller.close();
					},
				}),
			),
		{ stream: true, idleMs: 250 },
	);
	try {
		const first = await new Promise<string>((resolve, reject) => {
			const req = httpRequest({
				socketPath: socket,
				path: "/",
				method: "POST",
			});
			req.on("response", (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => {
					chunks.push(chunk);
					if (Buffer.concat(chunks).toString() === "first") release();
				});
				res.on("end", () => resolve(Buffer.concat(chunks).toString()));
				res.on("error", reject);
			});
			req.on("error", reject);
			req.end("{}");
		});
		// "first" reached the client before the gate opened, and the body outlived idleMs in total.
		expect(first).toBe("firstxxxx");
	} finally {
		await listener.stop(true);
	}
});
