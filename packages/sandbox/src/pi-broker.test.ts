import { expect, test } from "bun:test";
import { recordingLogger } from "pi-roundtable/testing";
import { PiSandboxBroker } from "./pi-broker.ts";
import { piModelInput } from "./pi-model-input.ts";
import { bound, message, post } from "./testing/pi-broker-fixture.ts";

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
