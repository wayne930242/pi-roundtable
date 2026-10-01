import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ConfigError } from "pi-roundtable";
import {
	ContextForgeAdmin,
	contextForgeToken,
	resolveVirtualServer,
} from "./contextforge.ts";

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
