import { describe, expect, test } from "bun:test";
import type { ActorFacts } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { decide } from "./authz.ts";
import { ConsoleServer } from "./console-server.ts";
import { DiagramService } from "./diagram-route.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit, refuse } from "./verifier.ts";
import type { Identified, Visitor } from "./visitors.ts";

const MEMBER: Visitor = {
	principal: { id: "member", displayName: "Member", disabled: false },
	tier: "member",
	speakerId: "member",
	roles: [],
};
const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

const encode = (source: string): string =>
	Buffer.from(source, "utf8").toString("base64url");
const FLOW = "graph TD\n  A[Start] --> B[Done]";
const url = (source: string, scheme = "light") =>
	`http://host/console/api/diagram?scheme=${scheme}&s=${encode(source)}`;

function server(refused = false) {
	const recorder = recordingLogger();
	return new ConsoleServer({
		mount: "/console",
		assets,
		authenticator: createAuthenticator({
			auth: {
				mode: "verifier",
				verifier: () => (refused ? refuse("no") : admit()),
			},
			identify: async (
				_actor: ActorFacts | undefined,
			): Promise<Identified> => ({
				visitor: MEMBER,
			}),
			origin: ORIGIN,
			mount: "/console",
			title: "Console",
			logger: recorder.logger,
			dataDir: "unused",
			listener: { id: "public", address: undefined },
		}),
		api: { handle: async () => Response.json({ ok: true }) },
		subscribe: () => undefined,
		logger: recorder.logger,
	});
}

describe("GET api/diagram", () => {
	test("draws a diagram as an SVG image for any admitted viewer, with its own headers", async () => {
		const response = await server().handle(new Request(url(FLOW)));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/svg+xml");
		expect(response.headers.get("cache-control")).toBe(
			"private, max-age=31536000, immutable",
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; style-src 'unsafe-inline'",
		);
		const svg = await response.text();
		expect(svg).toContain("<svg");
		expect(svg).toContain("Start");
		expect(svg).not.toContain("<script");
		expect(svg).not.toContain("@import");
	});

	test("draws a dark diagram in other colours than a light one", async () => {
		const light = await (await server().handle(new Request(url(FLOW)))).text();
		const dark = await (
			await server().handle(new Request(url(FLOW, "dark")))
		).text();
		expect(dark).not.toBe(light);
	});

	test("answers nobody the verifier refuses, and the table lists it for every viewer", async () => {
		expect((await server(true).handle(new Request(url(FLOW)))).status).toBe(
			403,
		);
		for (const tier of ["owner", "admin", "member"] as const)
			expect(decide("GET", "api/diagram", { tier, gated: false }).allow).toBe(
				true,
			);
		expect(
			decide("GET", "api/diagram", { tier: "member", gated: true }).allow,
		).toBe(false);
	});

	test("refuses a source over 8 KB, an unknown scheme and a source that is not base64url", async () => {
		const big = `graph TD\n${"  A --> B\n".repeat(900)}`;
		expect(Buffer.byteLength(big)).toBeGreaterThan(8 * 1024);
		expect((await server().handle(new Request(url(big)))).status).toBe(413);
		expect(
			(await server().handle(new Request(url(FLOW, "sepia")))).status,
		).toBe(400);
		expect(
			(
				await server().handle(
					new Request("http://host/console/api/diagram?scheme=light&s=%%%"),
				)
			).status,
		).toBe(400);
		expect(
			(
				await server().handle(
					new Request("http://host/console/api/diagram?scheme=light"),
				)
			).status,
		).toBe(400);
	});

	test("answers 422 for a source it cannot draw, and caches nothing about it", async () => {
		const response = await server().handle(new Request(url("not a diagram")));
		expect(response.status).toBe(422);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	test("only reads: a write is refused", async () => {
		const response = await server().handle(
			new Request(url(FLOW), { method: "POST" }),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
	});
});

describe("DiagramService", () => {
	const request = (source: string, scheme = "light") =>
		new Request(url(source, scheme));

	test("keeps the last renders by scheme and source, and draws a repeat once", async () => {
		const drawn: string[] = [];
		const service = new DiagramService({
			capacity: 2,
			render: (source, scheme) => {
				drawn.push(`${scheme}:${source}`);
				return `<svg>${source}</svg>`;
			},
		});
		for (const source of ["a", "a", "b", "a"])
			expect(await service.serve(request(source)).text()).toBe(
				`<svg>${source}</svg>`,
			);
		expect(drawn).toEqual(["light:a", "light:b"]);
		await service.serve(request("a", "dark")).text();
		expect(drawn).toEqual(["light:a", "light:b", "dark:a"]);
	});

	test("drops the least recently used render past its capacity", async () => {
		const drawn: string[] = [];
		const service = new DiagramService({
			capacity: 2,
			render: (source) => {
				drawn.push(source);
				return `<svg>${source}</svg>`;
			},
		});
		for (const source of ["a", "b", "a", "c", "b", "a"])
			await service.serve(request(source)).text();
		// c pushed b out (a was used after b); b came back and pushed a out.
		expect(drawn).toEqual(["a", "b", "c", "b", "a"]);
	});

	test("holds 200 renders by default", async () => {
		const drawn: string[] = [];
		const service = new DiagramService({
			render: (source) => {
				drawn.push(source);
				return "<svg/>";
			},
		});
		for (let i = 0; i < 200; i++) await service.serve(request(`n${i}`)).text();
		for (let i = 0; i < 200; i++) await service.serve(request(`n${i}`)).text();
		expect(drawn).toHaveLength(200);
		await service.serve(request("n200")).text();
		await service.serve(request("n0")).text();
		expect(drawn).toHaveLength(202);
	});

	test("does not keep a render that failed", async () => {
		let calls = 0;
		const service = new DiagramService({
			render: () => {
				calls++;
				throw new Error("not a diagram");
			},
		});
		expect(service.serve(request("x")).status).toBe(422);
		expect(service.serve(request("x")).status).toBe(422);
		expect(calls).toBe(2);
	});
});
