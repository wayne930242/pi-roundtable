import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLogger } from "pi-roundtable/testing";
import { listenBroker } from "./broker.ts";
import { PiSandboxBroker } from "./pi-broker.ts";
import { piModelInput } from "./pi-model-input.ts";
import {
	PI_MEDIA_LIMITS,
	type PiThinkingLevel,
	validateImages,
	validateReplyFiles,
} from "./pi-protocol.ts";

const post = (path: string, body: unknown) =>
	new Request(`http://broker${path}`, {
		method: "POST",
		headers: { authorization: "Bearer guest-token", cookie: "guest=1" },
		body: JSON.stringify(body),
	});
const message = {
	model: "guest-choice",
	messages: [{ role: "user", content: "Hello" }],
	max_tokens: 1_000_000,
};
function bound(broker: PiSandboxBroker, thinking: PiThinkingLevel = "xhigh") {
	const controller = new AbortController();
	const release = broker.bind({
		channel: "discord:channel",
		profile: "profile",
		speaker: { id: "guest", name: "Guest" },
		thinking,
		signal: controller.signal,
	});
	return { controller, release };
}
test("subscription broker swaps auth, fixes model/output budget, rebuilds headers and refuses routes", async () => {
	let seen: { url: string; init: RequestInit } | undefined;
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		fetchImpl: async (url, init) => {
			seen = { url, init };
			return Response.json({ content: "ok" });
		},
	});
	const { release } = bound(broker);
	expect(
		(await broker.handle(post("/anthropic/v1/messages", message))).status,
	).toBe(200);
	expect(seen?.url).toBe("https://api.anthropic.com/v1/messages");
	const headers = new Headers(seen?.init.headers);
	expect(headers.get("authorization")).toBe("Bearer host-secret");
	expect(headers.get("cookie")).toBeNull();
	expect(JSON.parse(String(seen?.init.body))).toMatchObject({
		model: "host-model",
		max_tokens: 128_000,
	});
	for (const path of [
		"/anthropic/v1/files",
		"/anthropic/v1/organizations",
		"/anthropic/v1/messages?endpoint=other",
		"/tools/shell",
		"/mcp/owner",
	])
		expect((await broker.handle(post(path, message))).status).not.toBe(200);
	release();
	expect(
		(await broker.handle(post("/anthropic/v1/messages", message))).status,
	).toBe(410);
});
test("host binds identity, ignoring guest impersonation and tool target fields", async () => {
	let context: unknown;
	const broker = new PiSandboxBroker({
		model: "model",
		oauthToken: () => "host-secret",
		tools: {
			names: ["remember_person"],
			call: async (_name, _input, host) => {
				context = host;
				return { ok: true, text: "stored" };
			},
		},
	});
	const { controller, release } = bound(broker);
	expect(
		(
			await broker.handle(
				post("/tools/remember_person", {
					channel: "discord:owner",
					author: { id: "owner" },
					input: { speaker: "owner" },
				}),
			)
		).status,
	).toBe(200);
	expect(context).toMatchObject({
		channel: "discord:channel",
		speaker: { id: "guest", name: "Guest" },
	});
	controller.abort();
	expect(
		(await broker.handle(post("/tools/remember_person", { input: {} }))).status,
	).toBe(410);
	release();
});
test("eager MCP startup permits only bounded metadata handshake before any admitted turn", async () => {
	const methods: unknown[] = [];
	const broker = new PiSandboxBroker({
		model: "model",
		oauthToken: () => "host-secret",
		mcp: {
			token: () => "mcp-secret",
			servers: [
				{ name: "research", url: "https://mcp.test", tools: ["search"] },
			],
		},
		fetchImpl: async (_url, init) => {
			methods.push(JSON.parse(String(init.body)).method);
			expect(new Headers(init.headers).get("authorization")).toBe(
				"Bearer mcp-secret",
			);
			expect(init.redirect).toBe("error");
			return Response.json({ result: {} });
		},
	});
	for (const method of [
		"initialize",
		"notifications/initialized",
		"tools/list",
	])
		expect(
			(
				await broker.handle(
					post("/mcp/research", { jsonrpc: "2.0", id: 1, method, params: {} }),
				)
			).status,
		).toBe(200);
	expect(
		(
			await broker.handle(
				post("/mcp/research", {
					method: "tools/call",
					params: { name: "search", arguments: {} },
				}),
			)
		).status,
	).toBe(403);
	const { release } = bound(broker);
	expect(
		(
			await broker.handle(
				post("/mcp/research", {
					method: "tools/call",
					params: { name: "search", arguments: {} },
				}),
			)
		).status,
	).toBe(200);
	for (const method of [
		"resources/read",
		"prompts/get",
		"sampling/createMessage",
	])
		expect(
			(await broker.handle(post("/mcp/research", { method, params: {} })))
				.status,
		).toBe(403);
	expect(
		(
			await broker.handle(
				post("/mcp/research", {
					method: "tools/call",
					params: { name: "owner_memory", arguments: {} },
				}),
			)
		).status,
	).toBe(403);
	release();
	expect(
		(await broker.handle(post("/mcp/research", { method: "initialize" })))
			.status,
	).toBe(410);
	expect(methods).toEqual([
		"initialize",
		"notifications/initialized",
		"tools/list",
		"tools/call",
	]);
});
test("model payload refuses remote schemas, URLs and native provider tools while keeping ordinary Pi tool transcripts", () => {
	const ordinary = {
		...message,
		tools: [
			{
				name: "remember_person",
				input_schema: {
					type: "object",
					properties: { url: { type: "string" } },
				},
			},
		],
		messages: [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call-1",
						name: "remember_person",
						input: { key: "summary" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call-1", content: "done" },
				],
			},
		],
	};
	expect(piModelInput(ordinary, "host", false).tools).toBeDefined();
	for (const input of [
		{
			...ordinary,
			tools: [{ name: "tool", type: "web_search_20250305", input_schema: {} }],
		},
		{
			...ordinary,
			tools: [
				{
					name: "tool",
					input_schema: {
						properties: { value: { $ref: "https://internal.test/schema" } },
					},
				},
			],
		},
		{
			...ordinary,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "url", url: "http://127.0.0.1" } },
					],
				},
			],
		},
		{
			...ordinary,
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "s", name: "web_search", input: {} },
					],
				},
			],
		},
		{ ...ordinary, tool_choice: { type: "web_search" } },
	])
		expect(() => piModelInput(input, "host", false)).toThrow();
});
test("Claude Code's mid-conversation system messages are rebuilt and forwarded, their effort capped", async () => {
	let sent: Record<string, unknown> | undefined;
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		fetchImpl: async (_url, init) => {
			sent = JSON.parse(String(init?.body));
			return Response.json({ content: "ok" });
		},
	});
	const { release } = bound(broker, "low");
	// The shape Claude Code 2.1.284 sends, recorded: the turn's environment after the prompt.
	const response = await broker.handle(
		post("/anthropic/v1/messages", {
			...message,
			messages: [
				{ role: "user", content: "roll" },
				{
					role: "system",
					content: [
						{
							type: "text",
							text: "# Environment\nToday's date is 2026-10-03.",
							cache_control: { type: "ephemeral" },
						},
					],
					output_config: { effort: "max" },
					clear_at: "next_user_message",
					smuggled: "dropped",
				},
				{ role: "system", content: "a reminder" },
			],
		}),
	);
	expect(response.status).toBe(200);
	expect(sent?.messages).toEqual([
		{ role: "user", content: "roll" },
		{
			role: "system",
			content: [
				{
					type: "text",
					text: "# Environment\nToday's date is 2026-10-03.",
					cache_control: { type: "ephemeral" },
				},
			],
			clear_at: "next_user_message",
			// The host judged this turn low; the guest cannot raise it here either.
			output_config: { effort: "low" },
		},
		{ role: "system", content: "a reminder" },
	]);
	release();
});
test("a refused model request is a 400 in the API's error shape, worded so Claude Code can resend without what was refused", async () => {
	let called = false;
	const logger = recordingLogger();
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		logger: logger.logger,
		fetchImpl: async () => {
			called = true;
			return Response.json({ content: "ok" });
		},
	});
	const { release } = bound(broker);
	const refuse = async (messages: unknown[]) => {
		const response = await broker.handle(
			post("/anthropic/v1/messages", { ...message, messages }),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
		return body.error.message;
	};
	// A tool change in a system message: Claude Code matches "Input tag 'tool_addition'" and
	// resends with its tools declared whole.
	expect(
		await refuse([
			{ role: "user", content: "Hello" },
			{
				role: "system",
				content: [{ type: "tool_addition", tool: { name: "late_tool" } }],
			},
		]),
	).toStartWith("messages.1.content.0: Input tag 'tool_addition'");
	// Any other role: Claude Code matches "Unexpected role" and "input message role".
	const role = await refuse([{ role: "developer", content: "x" }]);
	expect(role).toContain("Unexpected role");
	expect(role).toContain("input message role");
	// Any other refused shape is a 400 too, never a 502 the client would retry unchanged.
	const native = await broker.handle(
		post("/anthropic/v1/messages", {
			...message,
			tool_choice: { type: "web_search" },
		}),
	);
	expect(native.status).toBe(400);
	expect(called).toBe(false);
	expect(
		logger.lines.filter((l) => l.message === "sandbox upstream call failed")
			.length,
	).toBe(3);
	release();
});
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

test("upstream errors keep status, body and back-off headers; credentials still never leave", async () => {
	const replies = [
		new Response(
			'{"error":{"message":"prompt is too long: 213462 tokens > 200000 maximum"}}',
			{
				status: 400,
				headers: {
					"content-type": "application/json",
					"set-cookie": "a=b",
					"request-id": "req_1",
				},
			},
		),
		new Response("{}", {
			status: 429,
			headers: {
				"retry-after": "17",
				"anthropic-ratelimit-unified-status": "rejected",
				"x-internal": "no",
			},
		}),
		new Response("expired", { status: 404 }),
		new Response("host-secret", { status: 500 }),
	];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		mcp: {
			servers: [{ name: "pika", url: "https://mcp.example.test/x", tools: [] }],
			token: () => "mcp-secret",
		},
		fetchImpl: async () => replies.shift() as Response,
	});
	const { release } = bound(broker);
	const tooLong = await broker.handle(post("/anthropic/v1/messages", message));
	expect(tooLong.status).toBe(400);
	expect(await tooLong.text()).toContain("prompt is too long");
	expect(tooLong.headers.get("request-id")).toBe("req_1");
	expect(tooLong.headers.get("set-cookie")).toBeNull();
	const limited = await broker.handle(post("/anthropic/v1/messages", message));
	expect(limited.status).toBe(429);
	expect(limited.headers.get("retry-after")).toBe("17");
	expect(limited.headers.get("anthropic-ratelimit-unified-status")).toBe(
		"rejected",
	);
	expect(limited.headers.get("x-internal")).toBeNull();
	await limited.text();
	const expired = await broker.handle(
		post("/mcp/pika", { jsonrpc: "2.0", id: 1, method: "ping" }),
	);
	expect(expired.status).toBe(404);
	await expired.text();
	const reflected = await broker.handle(
		post("/anthropic/v1/messages", message),
	);
	await expect(reflected.text()).rejects.toThrow();
	release();
});

test("a restarted worker gets the metadata-only startup window again, in the order the worker connects", async () => {
	const broker = new PiSandboxBroker({
		model: "model",
		oauthToken: () => "host-secret",
		mcp: {
			token: () => "mcp-secret",
			servers: [
				{ name: "research", url: "https://mcp.test", tools: ["search"] },
			],
		},
		fetchImpl: async () => Response.json({ result: {} }),
	});
	const rpc = (method: string, params: unknown = {}) =>
		broker
			.handle(post("/mcp/research", { jsonrpc: "2.0", id: 1, method, params }))
			.then((response) => response.status);
	// The worker's order: discovery, then MCP connect, and only later /worker/ready.
	const discover = () =>
		broker.handle(new Request("http://broker/mcp-tools", { method: "GET" }));
	const { release } = bound(broker);
	release();
	expect(await rpc("initialize")).toBe(410);
	// Too soon after the last window: a compromised worker cannot loop this.
	await discover();
	expect(await rpc("initialize")).toBe(410);
	const now = Date.now;
	Date.now = () => now() + 11_000;
	try {
		expect((await discover()).status).toBe(200);
		expect(await rpc("initialize")).toBe(200);
		expect(await rpc("tools/list")).toBe(200);
		expect(await rpc("tools/call", { name: "search", arguments: {} })).toBe(
			403,
		);
		expect(
			(await broker.handle(post("/anthropic/v1/messages", message))).status,
		).toBe(410);
	} finally {
		Date.now = now;
	}
});

const compactRequest = {
	reason: "threshold",
	tokensBefore: 310_000,
	firstKeptEntryId: "kept",
	isSplitTurn: false,
	messagesToSummarize: [],
	turnPrefixMessages: [],
	keptMessages: [],
	readFiles: [],
	modifiedFiles: [],
};

test("a host compactor gets at most half the turn's time left, so Pi's summary still fits", async () => {
	const recorder = recordingLogger();
	const signals: AbortSignal[] = [];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		logger: recorder.logger,
		compaction: {
			engine: "host-compactor",
			timeoutMs: 120_000,
			compact: (_request, { signal }) => {
				signals.push(signal);
				return new Promise(() => {});
			},
		},
	});
	const turn = new AbortController();
	const bind = (deadline: number) =>
		broker.bind({
			channel: "discord:channel",
			profile: "profile",
			speaker: { id: "guest", name: "Guest" },
			thinking: "low",
			signal: turn.signal,
			deadline,
		});
	// Under two seconds left: no time for the compactor at all.
	let release = bind(Date.now() + 1500);
	const late = await broker.handle(post("/compaction/compact", compactRequest));
	expect(await late.json()).toEqual({
		ok: false,
		fallback: "the turn has too little time left for the host compactor",
	});
	expect(signals).toHaveLength(0);
	release();
	// Four seconds left: the compactor gets two, not its own 120.
	release = bind(Date.now() + 4000);
	const started = Date.now();
	const cut = (await (
		await broker.handle(post("/compaction/compact", compactRequest))
	).json()) as { ok: boolean; fallback: string };
	expect(cut.ok).toBe(false);
	expect(cut.fallback).toMatch(/^the compactor took over (19\d\d|2000) ms$/);
	expect(Date.now() - started).toBeLessThan(3000);
	expect(signals[0]?.aborted).toBe(true);
	release();
}, 10_000);

test("an error event in the middle of a 200 stream is logged, and the worker still gets the stream", async () => {
	const recorder = recordingLogger();
	const stream =
		'event: message_start\ndata: {"type":"message_start"}\n\n' +
		'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded host-secret"}}\n\n';
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		logger: recorder.logger,
		fetchImpl: async () =>
			new Response(
				// Split mid-event, as a network would.
				new ReadableStream({
					start(controller) {
						const bytes = new TextEncoder().encode(
							stream.replace(" host-secret", ""),
						);
						controller.enqueue(bytes.subarray(0, 70));
						controller.enqueue(bytes.subarray(70));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
	});
	const { release } = bound(broker);
	const response = await broker.handle(post("/anthropic/v1/messages", message));
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("overloaded_error");
	const failures = recorder.lines.filter(
		(line) => line.message === "sandbox upstream call failed",
	);
	expect(failures).toHaveLength(1);
	expect(failures[0]?.fields).toMatchObject({ status: 200 });
	expect(String(failures[0]?.fields.body)).toContain(
		'stream error event: {"type":"error","error":{"type":"overloaded_error"',
	);
	release();
});
test("subscription token is resolved per model call from the bound channel and speaker", async () => {
	const scopes: unknown[] = [];
	const seen: (string | null)[] = [];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: (scope) => {
			scopes.push(scope);
			return scope.channel === "discord:alpha" ? "alpha-secret" : "beta-secret";
		},
		fetchImpl: async (_url, init) => {
			seen.push(new Headers(init.headers).get("authorization"));
			return Response.json({ content: "ok" });
		},
	});
	for (const [channel, id] of [
		["discord:alpha", "guest-a"],
		["discord:beta", "guest-b"],
	] as const) {
		const release = broker.bind({
			channel,
			profile: "profile",
			speaker: { id, name: id },
			thinking: "high",
			signal: new AbortController().signal,
		});
		expect(
			(await broker.handle(post("/anthropic/v1/messages", message))).status,
		).toBe(200);
		release();
	}
	expect(seen).toEqual(["Bearer alpha-secret", "Bearer beta-secret"]);
	expect(scopes).toEqual([
		{ channel: "discord:alpha", speaker: { id: "guest-a", name: "guest-a" } },
		{ channel: "discord:beta", speaker: { id: "guest-b", name: "guest-b" } },
	]);
});

test("a request in flight keeps its own turn's token after the next turn binds", async () => {
	let sendBody!: () => void;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			sendBody = () => {
				controller.enqueue(new TextEncoder().encode(JSON.stringify(message)));
				controller.close();
			};
		},
	});
	const scopes: string[] = [];
	const seen: (string | null)[] = [];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: (scope) => {
			scopes.push(scope.channel);
			return scope.channel === "discord:alpha" ? "alpha-secret" : "beta-secret";
		},
		fetchImpl: async (_url, init) => {
			seen.push(new Headers(init.headers).get("authorization"));
			return Response.json({ content: "ok" });
		},
	});
	const turn = (channel: "discord:alpha" | "discord:beta", id: string) =>
		broker.bind({
			channel,
			profile: "profile",
			speaker: { id, name: id },
			thinking: "high",
			signal: new AbortController().signal,
		});
	const releaseA = turn("discord:alpha", "guest-a");
	// The body arrives only after turn A ends and turn B binds, so the token is resolved while B is bound.
	const inFlight = broker.handle(
		new Request("http://broker/anthropic/v1/messages", {
			method: "POST",
			headers: { authorization: "Bearer guest-token" },
			body,
			duplex: "half",
		} as RequestInit),
	);
	await Bun.sleep(0);
	releaseA();
	const releaseB = turn("discord:beta", "guest-b");
	sendBody();
	expect((await inFlight).status).toBe(200);
	expect(
		(await broker.handle(post("/anthropic/v1/messages", message))).status,
	).toBe(200);
	releaseB();
	expect(scopes).toEqual(["discord:alpha", "discord:beta"]);
	expect(seen).toEqual(["Bearer alpha-secret", "Bearer beta-secret"]);
});

for (const missing of [undefined, ""]) {
	test(`a subscription getter returning ${JSON.stringify(missing)} fails the call without reaching upstream`, async () => {
		let fetched = 0;
		const broker = new PiSandboxBroker({
			model: "host-model",
			oauthToken: () => missing,
			fetchImpl: async () => {
				fetched += 1;
				return Response.json({ content: "ok" });
			},
		});
		const release = broker.bind({
			channel: "discord:alpha",
			profile: "profile",
			speaker: { id: "guest-a", name: "guest-a" },
			thinking: "high",
			signal: new AbortController().signal,
		});
		const response = await broker.handle(
			post("/anthropic/v1/messages", message),
		);
		release();
		expect(response.status).toBe(502);
		expect(fetched).toBe(0);
	});
}
