import { describe, expect, test } from "bun:test";
import { recordingLogger } from "pi-roundtable/testing";
import type { AssetBundle } from "./assets.ts";
import { ConsoleServer } from "./console-server.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit, type RequestVerifier, refuse } from "./verifier.ts";

const assets: AssetBundle = new Map([
	[
		"index.html",
		{ body: Buffer.from("<html>console</html>"), type: "text/html" },
	],
	[
		"chunk-abc.js",
		{ body: Buffer.from("console.log(1)"), type: "text/javascript" },
	],
]);

function setup(verifier: RequestVerifier = () => admit(), coalesceMs?: number) {
	const listeners: (() => void)[] = [];
	const apiPaths: string[] = [];
	const recorder = recordingLogger();
	const server = new ConsoleServer({
		mount: "/console",
		assets,
		verifier,
		origin: ORIGIN,
		api: {
			handle: async (_request, path) => {
				apiPaths.push(path);
				return Response.json({ ok: true });
			},
		},
		subscribe: (listener) => listeners.push(listener),
		logger: recorder.logger,
		...(coalesceMs === undefined ? {} : { coalesceMs }),
	});
	return { server, listeners, apiPaths, recorder };
}

const get = (server: ConsoleServer, path: string, init: RequestInit = {}) =>
	server.handle(new Request(`http://host${path}`, init));

describe("ConsoleServer", () => {
	test("registers an exact route for the mount and a prefix route under it, on the chosen listener", () => {
		const { server } = setup();
		expect(
			server.routes("admin").map(({ listener, path }) => ({ listener, path })),
		).toEqual([
			{ listener: "admin", path: { exact: "/console" } },
			{ listener: "admin", path: { prefix: "/console/" } },
		]);
	});

	test("the mount redirects to its slash without asking the verifier", async () => {
		const { server } = setup(() => refuse("no"));
		const response = await get(server, "/console");
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/console/");
	});

	test("everything under the mount is refused when the verifier refuses, and reaches no data", async () => {
		const { server, apiPaths, recorder } = setup(() => refuse("no assertion"));
		for (const path of [
			"/console/",
			"/console/chunk-abc.js",
			"/console/api/config",
			"/console/api/events",
		]) {
			const response = await get(server, path);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("Forbidden");
		}
		expect(apiPaths).toEqual([]);
		expect(recorder.lines[0]).toMatchObject({
			level: "warn",
			fields: { refusal: "no assertion" },
		});
	});

	test("a verifier that throws or rejects admits no one", async () => {
		const throwing = setup(() => {
			throw new Error("keys unreachable");
		});
		expect((await get(throwing.server, "/console/")).status).toBe(403);
		const rejecting = setup(async () => {
			throw new Error("keys unreachable");
		});
		expect((await get(rejecting.server, "/console/api/config")).status).toBe(
			403,
		);
		expect(throwing.recorder.lines[0]?.fields.refusal).toBe("verifier failed");
	});

	test("serves the page with its security headers, assets, and the API once admitted", async () => {
		const { server, apiPaths } = setup();
		const page = await get(server, "/console/");
		expect(await page.text()).toBe("<html>console</html>");
		const csp = page.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("default-src 'self'");
		expect(page.headers.get("x-content-type-options")).toBe("nosniff");
		expect(page.headers.get("referrer-policy")).toBe("same-origin");
		const script = await get(server, "/console/chunk-abc.js");
		expect(await script.text()).toBe("console.log(1)");
		expect(script.headers.get("cache-control")).toContain("immutable");
		expect(script.headers.get("x-content-type-options")).toBe("nosniff");
		await get(server, "/console/api/notes/3");
		expect(apiPaths).toEqual(["notes/3"]);
		const api = await get(server, "/console/api/config");
		expect(api.headers.get("x-content-type-options")).toBe("nosniff");
		expect(api.headers.get("referrer-policy")).toBe("same-origin");
	});

	test("unknown paths answer 404, and the page is not served for them", async () => {
		const { server } = setup();
		expect((await get(server, "/console/other")).status).toBe(404);
		expect((await get(server, "/console/../secret")).status).toBe(404);
		expect((await get(server, "/elsewhere")).status).toBe(404);
		expect((await get(server, "/console/index.html")).status).toBe(200);
	});

	test("a request that changes data must come from the console's own origin", async () => {
		const { server, apiPaths } = setup();
		const write = (origin: string | undefined, method = "POST") =>
			get(server, "/console/api/notes", {
				method,
				...(origin ? { headers: { origin } } : {}),
			});
		expect((await write(undefined)).status).toBe(403);
		expect((await write("https://evil.example.test")).status).toBe(403);
		expect((await write(ORIGIN.replace("https", "http"))).status).toBe(403);
		expect((await write("https://evil.example.test", "DELETE")).status).toBe(
			403,
		);
		expect((await write("https://evil.example.test", "PATCH")).status).toBe(
			403,
		);
		expect(apiPaths).toEqual([]);
		expect((await write(ORIGIN)).status).toBe(200);
		expect((await write(ORIGIN, "DELETE")).status).toBe(200);
		expect(apiPaths).toEqual(["notes", "notes"]);
	});

	test("the origin is checked after the verifier, so a foreign origin proves nothing to an unauthenticated client", async () => {
		const { server, recorder } = setup(() => refuse("no assertion"));
		const response = await get(server, "/console/api/notes", {
			method: "POST",
			headers: { origin: ORIGIN },
		});
		expect(response.status).toBe(403);
		expect(recorder.lines[0]?.fields.refusal).toBe("no assertion");
	});

	test("the page and assets are read only", async () => {
		const { server } = setup();
		expect(
			(
				await get(server, "/console/", {
					method: "POST",
					headers: { origin: ORIGIN },
				})
			).status,
		).toBe(405);
	});

	test("the event stream says changed once for a burst of changes", async () => {
		const { server, listeners } = setup();
		const response = await get(server, "/console/api/events");
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no stream");
		const decoder = new TextDecoder();
		expect(decoder.decode((await reader.read()).value)).toBe("retry: 3000\n\n");
		for (const listener of listeners) {
			listener();
			listener();
			listener();
		}
		expect(decoder.decode((await reader.read()).value)).toBe(
			"event: changed\ndata: {}\n\n",
		);
		// A second burst after the first one is delivered is a second event, and only one.
		for (const listener of listeners) {
			listener();
			listener();
		}
		expect(decoder.decode((await reader.read()).value)).toBe(
			"event: changed\ndata: {}\n\n",
		);
		server.stop();
		expect((await reader.read()).done).toBe(true);
	});

	test("a change made before a stream opened is not sent to it", async () => {
		const { server, listeners } = setup();
		for (const listener of listeners) listener();
		const response = await get(server, "/console/api/events");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no stream");
		await reader.read(); // the retry line
		const pending = reader.read();
		const raced = await Promise.race([
			pending,
			new Promise((resolve) => setTimeout(() => resolve("quiet"), 400)),
		]);
		expect(raced).toBe("quiet");
		server.stop();
	});

	test("a client that stops reading is cut off after a backlog of events, and a reading one is not", async () => {
		const { server, listeners } = setup(() => admit(), 1);
		const slow = (await get(server, "/console/api/events")).body?.getReader();
		const keen = (await get(server, "/console/api/events")).body?.getReader();
		if (!slow || !keen) throw new Error("no stream");
		let keenEvents = 0;
		const draining = (async () => {
			for (;;) {
				const { done } = await keen.read();
				if (done) return;
				keenEvents++;
			}
		})();
		for (let i = 0; i < 40; i++) {
			for (const listener of listeners) listener();
			await new Promise((resolve) => setTimeout(resolve, 8));
		}
		// The slow client got its retry line and at most the backlog, and then its stream ended.
		let slowChunks = 0;
		for (;;) {
			const { done } = await slow.read();
			if (done) break;
			slowChunks++;
		}
		expect(slowChunks).toBeLessThanOrEqual(16);
		expect(keenEvents).toBeGreaterThan(20);
		server.stop();
		await draining;
	});

	test("refuses a thirty-third stream", async () => {
		const { server } = setup();
		for (let i = 0; i < 32; i++)
			expect((await get(server, "/console/api/events")).status).toBe(200);
		expect((await get(server, "/console/api/events")).status).toBe(503);
		server.stop();
	});
});
