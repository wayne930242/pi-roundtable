import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "../errors.ts";
import { HttpListeners, type HttpRoute, routeRequest } from "./listeners.ts";

const answer =
	(text: string, listener = "public", methods?: string[]) =>
	(path: HttpRoute["path"]): HttpRoute => ({
		name: `${text} ${JSON.stringify(path)}`,
		listener,
		path,
		...(methods ? { methods } : {}),
		handle: () => new Response(text),
	});

async function reply(
	routes: HttpRoute[],
	path: string,
	method = "GET",
): Promise<[number, string]> {
	const response = await routeRequest(
		routes,
		new Request(`http://localhost${path}`, { method }),
	);
	return [response.status, await response.text()];
}

function refused(build: () => unknown): unknown {
	try {
		build();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("routeRequest", () => {
	const routes = [
		answer("personal")({ exact: "/mcp/personal" }),
		answer("discord")({ prefix: "/mcp/discord/" }),
		answer("avatar", "public", ["GET", "HEAD"])({ prefix: "/avatars/" }),
	];

	test("takes exact paths, prefixes, and listed methods only", async () => {
		expect(await reply(routes, "/mcp/personal", "POST")).toEqual([
			200,
			"personal",
		]);
		expect(await reply(routes, "/mcp/personal", "DELETE")).toEqual([
			200,
			"personal",
		]);
		expect(await reply(routes, "/mcp/discord/abc", "POST")).toEqual([
			200,
			"discord",
		]);
		expect(await reply(routes, "/avatars/a.png")).toEqual([200, "avatar"]);
		expect(await reply(routes, "/avatars/a.png", "POST")).toEqual([
			404,
			"Not found",
		]);
		expect(await reply(routes, "/mcp/personal/more", "POST")).toEqual([
			404,
			"Not found",
		]);
		expect(await reply(routes, "/app/")).toEqual([404, "Not found"]);
	});
});

describe("HttpListeners", () => {
	test("refuses routes one request could reach twice, and unknown listeners", () => {
		const listeners = [
			{ id: "public", socketPath: "/tmp/p.sock" },
			{ id: "web", socketPath: "/tmp/w.sock" },
		];
		const build = (routes: HttpRoute[]) => () =>
			new HttpListeners(listeners, routes);
		expect(
			refused(
				build([
					answer("a")({ prefix: "/mcp/" }),
					answer("b")({ exact: "/mcp/personal" }),
				]),
			),
		).toBeInstanceOf(PluginError);
		expect(
			refused(
				build([
					answer("a")({ prefix: "/app/" }),
					answer("b")({ prefix: "/app/api/" }),
				]),
			),
		).toBeInstanceOf(PluginError);
		expect(
			refused(build([answer("a", "elsewhere")({ exact: "/" })])),
		).toBeInstanceOf(PluginError);
		// Different listeners or methods never clash.
		expect(
			refused(
				build([
					answer("a")({ prefix: "/app/" }),
					answer("b", "web")({ prefix: "/app/" }),
					answer("c", "public", ["GET"])({ exact: "/x" }),
					answer("d", "public", ["POST"])({ exact: "/x" }),
				]),
			),
		).toBeUndefined();
	});

	test("each socket serves only its own routes, open to cloudflared", async () => {
		const dir = mkdtempSync(join(tmpdir(), "listeners-"));
		const listeners = [
			{ id: "public", socketPath: join(dir, "public.sock") },
			{ id: "web", socketPath: join(dir, "web.sock") },
		];
		const http = new HttpListeners(listeners, [
			answer("mcp")({ exact: "/mcp/personal" }),
			answer("app", "web")({ prefix: "/app/" }),
		]);
		http.start();
		const get = async (socket: string, path: string) => {
			const response = await fetch(`http://localhost${path}`, {
				unix: join(dir, socket),
			});
			return [response.status, await response.text()];
		};
		try {
			expect(await get("public.sock", "/mcp/personal")).toEqual([200, "mcp"]);
			expect(await get("public.sock", "/app/")).toEqual([404, "Not found"]);
			expect(await get("web.sock", "/app/")).toEqual([200, "app"]);
			expect(await get("web.sock", "/mcp/personal")).toEqual([
				404,
				"Not found",
			]);
			expect(statSync(join(dir, "web.sock")).mode & 0o777).toBe(0o666);
		} finally {
			http.stop();
		}
	});

	test("serves a TCP listener with only its own routes", async () => {
		// A free port, found by opening one and closing it again.
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = probe.port ?? 0;
		await probe.stop(true);
		const http = new HttpListeners(
			[{ id: "public", port, hostname: "127.0.0.1" }],
			[answer("avatar")({ prefix: "/avatars/" })],
		);
		http.start();
		try {
			const get = async (path: string) => {
				const response = await fetch(`http://127.0.0.1:${port}${path}`);
				return [response.status, await response.text()];
			};
			expect(await get("/avatars/a.png")).toEqual([200, "avatar"]);
			expect(await get("/elsewhere")).toEqual([404, "Not found"]);
		} finally {
			http.stop();
		}
	});
});
