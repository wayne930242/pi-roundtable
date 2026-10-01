import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ConfigError } from "pi-roundtable";
import {
	ContextForgeAdmin,
	ContextForgeError,
	contextForgeToken,
	resolveVirtualServer,
} from "./contextforge.ts";
import { connectorMessages } from "./messages.ts";

const decode = (part: string) =>
	JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("contextForgeToken", () => {
	test("carries ContextForge's admin claims and a valid HS256 signature", () => {
		const token = contextForgeToken("s3cret", "admin@example.com", 60, 1000);
		const [header, payload, signature] = token.split(".");
		expect(decode(header ?? "")).toEqual({ alg: "HS256", typ: "JWT" });
		expect(decode(payload ?? "")).toMatchObject({
			sub: "admin@example.com",
			username: "admin@example.com",
			iat: 1000,
			exp: 1060,
			iss: "mcpgateway",
			aud: "mcpgateway-api",
			teams: null,
			user: { email: "admin@example.com", is_admin: true },
		});
		expect(decode(payload ?? "").jti).toMatch(/^[0-9a-f-]{36}$/);
		const expected = createHmac("sha256", "s3cret")
			.update(`${header}.${payload}`)
			.digest("base64url");
		expect(signature).toBe(expected);
	});
});

describe("resolveVirtualServer", () => {
	const fake = (routes: Record<string, unknown>) =>
		(async (url: string) => {
			const path = new URL(url).pathname;
			return path in routes
				? new Response(JSON.stringify(routes[path]))
				: new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

	test("finds the server by name and lists its tools", async () => {
		const server = await resolveVirtualServer(
			"http://cf:4444",
			"t",
			"workspace",
			fake({
				"/servers": [
					{ id: "a1", name: "other" },
					{ id: "b2", name: "workspace" },
				],
				"/servers/b2/tools": [
					{ name: "google-list-calendars" },
					{ name: "google-get-events" },
				],
			}),
		);
		expect(server).toEqual({
			name: "workspace",
			url: "http://cf:4444/servers/b2/mcp",
			tools: ["google-list-calendars", "google-get-events"],
		});
	});

	test("a missing server is a ConfigError", async () => {
		expect(
			resolveVirtualServer("http://cf", "t", "x", fake({ "/servers": [] })),
		).rejects.toBeInstanceOf(ConfigError);
	});

	test("an API error is a ConfigError", async () => {
		expect(
			resolveVirtualServer("http://cf", "t", "x", fake({})),
		).rejects.toBeInstanceOf(ConfigError);
	});
});

describe("ContextForgeAdmin reads", () => {
	const fake = (routes: Record<string, unknown>) =>
		(async (url: string) => {
			const path = new URL(url).pathname;
			return path in routes
				? new Response(JSON.stringify(routes[path]))
				: new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

	test("gateways carry state and tool counts, never their URL", async () => {
		const admin = new ContextForgeAdmin(
			"http://cf",
			"t",
			fake({
				"/gateways": [
					{
						name: "google",
						slug: "google",
						url: "http://google:8000/mcp",
						enabled: true,
						reachable: true,
					},
					{ name: "notes", url: "https://n/mcp/SECRET", enabled: true },
				],
				"/tools": [
					{ id: "1", name: "google-a", gatewaySlug: "google" },
					{ id: "2", name: "google-b", gatewaySlug: "google" },
					{ id: "3", name: "notes-a", gatewaySlug: "notes" },
				],
			}),
		);
		const gateways = await admin.gateways();
		expect(gateways).toEqual([
			{ name: "google", enabled: true, reachable: true, tools: 2 },
			{ name: "notes", enabled: true, reachable: false, tools: 1 },
		]);
		expect(JSON.stringify(gateways)).not.toContain("SECRET");
	});

	test("servers list their tool names", async () => {
		const admin = new ContextForgeAdmin(
			"http://cf",
			"t",
			fake({
				"/servers": [{ id: "b2", name: "workspace" }],
				"/servers/b2/tools": [{ name: "google-a" }, { name: "google-b" }],
			}),
		);
		expect(await admin.servers()).toEqual([
			{ name: "workspace", tools: ["google-a", "google-b"] },
		]);
	});
});

describe("ContextForge errors in the host's wording", () => {
	const words = connectorMessages({
		upstreamUrlUnreadable: (url) => `U:${url}`,
		contextForgeNoGatewayId: "G:none",
		contextForgeNoServerId: "S:none",
		contextForgeRefused: (status, detail) => `R:${status}:${detail}`,
		contextForgeNotJson: (detail) => `J:${detail}`,
		virtualServerRequestFailed: (url, status, detail) =>
			`V:${new URL(url).pathname}:${status}:${detail}`,
		virtualServerMissing: (name) => `M:${name}`,
		virtualServerNoTools: (name) => `T:${name}`,
	});
	const answering = (status: number, body: string) =>
		(async () => new Response(body, { status })) as unknown as typeof fetch;
	const gateway = {
		name: "x",
		url: "https://x.test/mcp",
		description: "x",
		auth: { type: "bearer", token: "tok-secret-9" } as const,
	};

	test("a refusal and a non-JSON answer use the host's wording, and still mask the token", async () => {
		const refused = new ContextForgeAdmin(
			"http://cf",
			"t",
			answering(422, JSON.stringify({ detail: "bad tok-secret-9" })),
			words,
		);
		const refusal = await refused.createGateway(gateway).catch((e) => e);
		expect(refusal).toBeInstanceOf(ContextForgeError);
		expect(refusal.message).toBe("R:422:bad ***");

		const html = new ContextForgeAdmin(
			"http://cf",
			"t",
			answering(200, "<html>tok-secret-9</html>"),
			words,
		);
		const notJson = await html.createGateway(gateway).catch((e) => e);
		expect(notJson.message).toBe("J:<html>***</html>");
	});

	test("a missing ID and an unreadable URL use the host's wording", async () => {
		const empty = new ContextForgeAdmin(
			"http://cf",
			"t",
			answering(200, "{}"),
			words,
		);
		expect((await empty.createGateway(gateway).catch((e) => e)).message).toBe(
			"G:none",
		);
		expect(
			(await empty.createServer("s", "d", []).catch((e) => e)).message,
		).toBe("S:none");
		expect(
			(
				await empty
					.createGateway({ ...gateway, url: "not a url" })
					.catch((e) => e)
			).message,
		).toBe("U:not a url");
	});

	test("resolving a virtual server refuses in the host's wording", async () => {
		const routes = (table: Record<string, unknown>) =>
			(async (url: string) => {
				const path = new URL(url).pathname;
				return path in table
					? new Response(JSON.stringify(table[path]))
					: new Response("nope", { status: 500 });
			}) as unknown as typeof fetch;
		const resolve = (table: Record<string, unknown>) =>
			resolveVirtualServer("http://cf", "t", "ws", routes(table), words).catch(
				(e) => e,
			);
		expect((await resolve({})).message).toBe("V:/servers:500:nope");
		expect((await resolve({ "/servers": [] })).message).toBe("M:ws");
		const found = { "/servers": [{ id: "a", name: "ws" }] };
		expect((await resolve({ ...found, "/servers/a/tools": [] })).message).toBe(
			"T:ws",
		);
	});
});
