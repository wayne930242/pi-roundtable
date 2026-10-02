import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unixBrokerRequest } from "../worker/transport.ts";
import { type BrokerOptions, SandboxBroker } from "./broker.ts";
import { DUMMY_KEY } from "./protocol.ts";

const context = {
	channel: "fake:guests" as const,
	speaker: { id: "guest-a", name: "Guest" },
	signal: new AbortController().signal,
};
function options(overrides: Partial<BrokerOptions> = {}): BrokerOptions {
	return {
		context,
		model: "test-model",
		modelUrl: "https://models.example/v1/chat/completions",
		apiKey: () => "real-model-key",
		...overrides,
	};
}
function request(
	path = "/model",
	body: unknown = { messages: [] },
	headers: Record<string, string> = {},
): Request {
	return new Request(`http://broker${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${DUMMY_KEY}`,
			...headers,
		},
		body: JSON.stringify(body),
	});
}

test("swaps the dummy credential, pins model/budget, and forwards no caller headers", async () => {
	let seen = false;
	const broker = new SandboxBroker(
		options({
			fetchImpl: async (url, init) => {
				seen = true;
				expect(String(url)).toBe("https://models.example/v1/chat/completions");
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer real-model-key",
				);
				expect(new Headers(init?.headers).get("user-agent")).toBeNull();
				expect(init?.redirect).toBe("error");
				const body = JSON.parse(String(init?.body));
				expect(body.model).toBe("test-model");
				expect(body.max_tokens).toBe(4096);
				expect(body.stream).toBe(false);
				expect(body.callback_url).toBeUndefined();
				return Response.json(
					{ choices: [] },
					{
						headers: {
							"set-cookie": "private=1",
							authorization: "Bearer real-model-key",
							connection: "close",
						},
					},
				);
			},
		}),
	);
	const reply = await broker.handle(
		request(
			"/model",
			{
				messages: [],
				model: "expensive",
				max_tokens: 999999,
				callback_url: "https://guest.example",
			},
			{ "user-agent": "guest" },
		),
	);
	expect(reply.status).toBe(200);
	expect(reply.headers.get("set-cookie")).toBeNull();
	expect(reply.headers.get("authorization")).toBeNull();
	expect(seen).toBe(true);
});

for (const header of [
	"connection",
	"keep-alive",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"x-api-key",
	"cookie",
	"forwarded",
	"x-forwarded-host",
	"x-provider-token",
]) {
	test(`refuses ${header} rather than forwarding it`, async () => {
		const broker = new SandboxBroker(
			options({
				fetchImpl: async () => {
					throw new Error("must not fetch");
				},
			}),
		);
		expect(
			(
				await broker.handle(
					request("/model", { messages: [] }, { [header]: "guest-supplied" }),
				)
			).status,
		).toBe(403);
	});
}

test("refuses non-dummy credentials and forged hosts", async () => {
	const broker = new SandboxBroker(options());
	expect(
		(
			await broker.handle(
				request("/model", { messages: [] }, { authorization: "Bearer stolen" }),
			)
		).status,
	).toBe(403);
	expect(
		(
			await broker.handle(
				request("/model", { messages: [] }, { host: "api.example" }),
			)
		).status,
	).toBe(403);
});

for (const route of [
	"/",
	"/health",
	"/anthropic/v1/messages",
	"/model/extra",
	"/model?url=https://guest.example",
	"/tools/bash",
	"/tools/read",
	"/tools/constructor",
	"/mcp/private",
	"/mcp/public/extra",
	"/tools/%62ash",
]) {
	test(`refuses unknown route ${route}`, async () => {
		expect(
			(await new SandboxBroker(options()).handle(request(route))).status,
		).toBe(404);
	});
}

test("only configured host tools run, with the host-bound identity", async () => {
	let calls = 0;
	const broker = new SandboxBroker(
		options({
			tools: [
				{
					name: "echo",
					description: "Echo",
					parameters: { type: "object" },
					run: (input, trusted) => {
						calls++;
						expect(trusted.channel).toBe(context.channel);
						expect(trusted.speaker.id).toBe("guest-a");
						expect(input.speaker).toBe("owner");
						return "allowed";
					},
				},
			],
		}),
	);
	expect(
		(
			await broker.handle(
				request("/tools/echo", { speaker: "owner", channel: "fake:private" }),
			)
		).status,
	).toBe(200);
	expect((await broker.handle(request("/tools/bash"))).status).toBe(404);
	expect(calls).toBe(1);
});

test("MCP pins server, tool and method, replaces credential and strips arbitrary RPC fields", async () => {
	let calls = 0;
	const broker = new SandboxBroker(
		options({
			mcp: [
				{
					name: "public",
					url: "https://mcp.example/rpc",
					apiKey: () => "real-mcp-key",
					tools: [
						{
							name: "search",
							description: "Search",
							parameters: { type: "object" },
						},
					],
				},
			],
			fetchImpl: async (url, init) => {
				calls++;
				expect(String(url)).toBe("https://mcp.example/rpc");
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer real-mcp-key",
				);
				expect(JSON.parse(String(init?.body))).toEqual({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "search", arguments: { query: "hello" } },
				});
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { content: [{ type: "text", text: "found" }] },
				});
			},
		}),
	);
	for (const body of [
		{ method: "resources/read", params: {} },
		{ method: "tools/call", params: { name: "delete", arguments: {} } },
		[{ method: "tools/call", params: { name: "search", arguments: {} } }],
	]) {
		expect((await broker.handle(request("/mcp/public", body))).status).not.toBe(
			200,
		);
	}
	expect(
		(
			await broker.handle(
				request("/mcp/public", {
					method: "tools/call",
					params: { name: "search", arguments: { query: "hello" } },
					url: "https://guest.example",
					id: 99,
				}),
			)
		).status,
	).toBe(200);
	expect(calls).toBe(1);
});

test("reflected credentials and detailed upstream failures never leave the broker", async () => {
	for (const response of [
		Response.json({ token: "real-model-key" }),
		new Response("real-model-key", { status: 401 }),
	]) {
		const broker = new SandboxBroker(
			options({ fetchImpl: async () => response }),
		);
		const reply = await broker.handle(request());
		expect(reply.status).toBe(502);
		expect(await reply.text()).not.toContain("real-model-key");
	}
});

test("missing credential, invalid input, body size and finite call budget fail closed", async () => {
	const broker = new SandboxBroker(
		options({ apiKey: () => undefined, maxCalls: 2 }),
	);
	expect((await broker.handle(request())).status).toBe(502);
	expect(
		(await broker.handle(request("/model", "x".repeat(270_000)))).status,
	).toBe(502);
	expect((await broker.handle(request())).status).toBe(429);
	expect(
		() => new SandboxBroker(options({ modelUrl: "http://unsafe.example" })),
	).toThrow();
	expect(
		() =>
			new SandboxBroker(
				options({ modelUrl: "https://user:pass@unsafe.example" }),
			),
	).toThrow();
});

test("JSON-escaped credentials are refused after decoding", async () => {
	const broker = new SandboxBroker(
		options({
			fetchImpl: async () =>
				new Response('{"token":"real\\u002dmodel\\u002dkey"}', {
					headers: { "content-type": "application/json" },
				}),
		}),
	);
	expect((await broker.handle(request())).status).toBe(502);
});

test("actual upstream redirects never receive the credential at their target", async () => {
	let leakedCalls = 0;
	const destination = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			leakedCalls++;
			return Response.json({});
		},
	});
	const redirect = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response(null, {
				status: 307,
				headers: { location: `http://127.0.0.1:${destination.port}/stolen` },
			}),
	});
	try {
		const broker = new SandboxBroker(
			options({
				modelUrl: `http://127.0.0.1:${redirect.port}/chat`,
				allowHttp: true,
			}),
		);
		expect((await broker.handle(request())).status).toBe(502);
		expect(leakedCalls).toBe(0);
	} finally {
		await redirect.stop(true);
		await destination.stop(true);
	}
});

test("broker rejects provider-side media before sending any upstream request", async () => {
	let calls = 0;
	const broker = new SandboxBroker(
		options({
			fetchImpl: async () => {
				calls++;
				return Response.json({});
			},
		}),
	);
	expect(
		(
			await broker.handle(
				request("/model", {
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image_url",
									image_url: { url: "https://guest.example/metadata" },
								},
							],
						},
					],
				}),
			)
		).status,
	).toBe(400);
	expect(calls).toBe(0);
});

test("Unix listener caps open connections and closes incomplete headers on shutdown", async () => {
	const dir = mkdtempSync("/tmp/sb-connections-");
	const socketPath = join(dir, "broker.sock");
	const listener = await new SandboxBroker(options()).listen(socketPath);
	const sockets: Socket[] = [];
	const closed = new Set<Socket>();
	try {
		await Promise.all(
			Array.from(
				{ length: 24 },
				() =>
					new Promise<void>((resolve) => {
						const socket = createConnection(socketPath);
						sockets.push(socket);
						socket.once("connect", resolve);
						socket.once("error", resolve);
						socket.once("close", () => {
							closed.add(socket);
							resolve();
						});
					}),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(closed.size).toBeGreaterThanOrEqual(8);
	} finally {
		await listener.stop(true);
		for (const socket of sockets) socket.destroy();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the real Unix listener accepts worker transport and keeps socket private", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sandbox-broker-"));
	const socket = join(dir, "broker.sock");
	const server = await new SandboxBroker(
		options({ fetchImpl: async () => Response.json({ choices: [] }) }),
	).listen(socket);
	try {
		const reply = await unixBrokerRequest("/model", { messages: [] }, socket);
		expect(reply.status).toBe(200);
	} finally {
		await server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
});
