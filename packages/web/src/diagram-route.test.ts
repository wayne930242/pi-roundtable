import { describe, expect, setSystemTime, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { ActorFacts } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { decide } from "./authz.ts";
import { ConsoleServer } from "./console-server.ts";
import { DiagramRefusal, DiagramRenderer } from "./diagram-renderer.ts";
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
			expect(await (await service.serve(request(source))).text()).toBe(
				`<svg>${source}</svg>`,
			);
		expect(drawn).toEqual(["light:a", "light:b"]);
		await (await service.serve(request("a", "dark"))).text();
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
			await (await service.serve(request(source))).text();
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
		for (let i = 0; i < 200; i++)
			await (await service.serve(request(`n${i}`))).text();
		for (let i = 0; i < 200; i++)
			await (await service.serve(request(`n${i}`))).text();
		expect(drawn).toHaveLength(200);
		await (await service.serve(request("n200"))).text();
		await (await service.serve(request("n0"))).text();
		expect(drawn).toHaveLength(202);
	});

	test("remembers a source it could not draw, and answers it again without drawing", async () => {
		let calls = 0;
		const service = new DiagramService({
			render: () => {
				calls++;
				throw new Error("not a diagram");
			},
		});
		expect((await service.serve(request("x"))).status).toBe(422);
		expect((await service.serve(request("x"))).status).toBe(422);
		expect(calls).toBe(1);
	});

	test("a refused source is remembered by its hash and scheme, so a repeat costs nothing", async () => {
		const service = new DiagramService({
			render: async () => {
				throw new Error("not a diagram");
			},
		});
		expect((await service.serve(request("x", "dark"))).status).toBe(422);
		const again = performance.now();
		expect((await service.serve(request("x", "dark"))).status).toBe(422);
		expect(performance.now() - again).toBeLessThan(20);
	});
});

/** A source of about 8 KB that takes the renderer a second or so: a long chain of nodes. */
const HEAVY = `graph LR\n${Array.from({ length: 800 }, (_, i) => `${i}-->${i + 1}`).join("\n")}`;

describe("the drawing of a diagram", () => {
	const request = (source: string) => new Request(url(source));

	test("never holds the event loop: other work runs while a heavy diagram is drawn", async () => {
		expect(Buffer.byteLength(HEAVY)).toBeLessThanOrEqual(8 * 1024);
		// The limit is far off: this test is about the event loop, not about giving up.
		const service = new DiagramService({ timeoutMs: 30_000 });
		await service.serve(request(FLOW));
		// A timer set before the drawing starts must fire on time while it runs.
		const started = performance.now();
		const timer = new Promise<number>((resolve) =>
			setTimeout(() => resolve(performance.now() - started), 5),
		);
		const drawing = service.serve(request(HEAVY));
		const waited = await timer;
		const response = await drawing;
		expect(response.status).toBe(200);
		expect(waited).toBeLessThan(150);
	}, 60_000);

	test("gives up on a drawing past its time, answers 422 and remembers that", async () => {
		const service = new DiagramService({ timeoutMs: 400 });
		const first = await service.serve(request(HEAVY));
		expect(first.status).toBe(422);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const again = performance.now();
		expect((await service.serve(request(HEAVY))).status).toBe(422);
		expect(performance.now() - again).toBeLessThan(20);
		// The next diagram is drawn by a fresh worker; on a loaded machine its first drawing can
		// itself pass the limit, so a few small ones are tried.
		const statuses: number[] = [];
		for (let i = 0; i < 5 && !statuses.includes(200); i++)
			statuses.push(
				(await service.serve(request(`graph TD\n  A${i}-->B${i}`))).status,
			);
		expect(statuses).toContain(200);
	}, 60_000);

	test("draws one at a time and turns away what waits beyond its queue, with 503 and no memory of it", async () => {
		const service = new DiagramService({ timeoutMs: 20_000, queue: 1 });
		await service.serve(request(FLOW));
		const other = (n: number) => `${HEAVY}\nZ${n}-->Y${n}`;
		const answers = await Promise.all([
			service.serve(request(other(1))),
			service.serve(request(other(2))),
			service.serve(request(other(3))),
		]);
		expect(answers.map((a) => a.status)).toEqual([200, 200, 503]);
		expect(answers[2]?.headers.get("cache-control")).toBe("no-store");
		expect((await service.serve(request(other(3)))).status).toBe(200);
	}, 60_000);

	test("draws the same source once for requests that arrive together", async () => {
		let calls = 0;
		const service = new DiagramService({
			render: async () => {
				calls++;
				await Bun.sleep(30);
				return "<svg/>";
			},
		});
		await Promise.all([1, 2, 3].map(() => service.serve(request("same"))));
		expect(calls).toBe(1);
	});
});

describe("DiagramRenderer workers", () => {
	test("every worker it starts ends, however drawings time out and queue", async () => {
		let created = 0;
		let exited = 0;
		const renderer = new DiagramRenderer({
			timeoutMs: 60,
			queue: 30,
			spawn: () => {
				created += 1;
				// Answers ready, then draws only what says "ok".
				const worker = new Worker(
					`const { parentPort: p } = require("node:worker_threads");
					p.postMessage({ ready: true });
					p.on("message", (job) => { if (job.source.includes("ok")) p.postMessage({ id: job.id, svg: "<svg/>" }); });`,
					{ eval: true },
				);
				worker.once("exit", () => {
					exited += 1;
				});
				return worker;
			},
		});
		await Promise.allSettled(
			Array.from({ length: 12 }, (_, i) =>
				renderer.draw(`graph TD\n A${i}-->${i % 2 ? "ok" : "hang"}`, "light"),
			),
		);
		await Bun.sleep(300);
		expect(created).toBeGreaterThan(1);
		expect(created - exited).toBeLessThanOrEqual(1);
	});

	test("a worker that fails to start is busy, not a verdict kept for the source", async () => {
		let starts = 0;
		const renderer = new DiagramRenderer({
			spawn: () => {
				starts += 1;
				return new Worker("throw new Error('no start')", { eval: true });
			},
		});
		const service = new DiagramService({
			render: (source, scheme) => renderer.draw(source, scheme),
		});
		const url = `http://x/api/diagram?scheme=light&s=${Buffer.from("graph TD\nA-->B").toString("base64url")}`;
		expect((await service.serve(new Request(url))).status).toBe(503);
		expect((await service.serve(new Request(url))).status).toBe(503);
		expect(starts).toBe(2);
	});
});

test("a drawing that overran is tried again after a while; a source that is no diagram is not", async () => {
	let calls = 0;
	const service = new DiagramService({
		render: (source) => {
			calls += 1;
			if (source.startsWith("graph")) {
				if (calls === 1) throw new DiagramRefusal("slow");
				return "<svg/>";
			}
			throw new DiagramRefusal("invalid");
		},
	});
	const ask = (source: string) =>
		service.serve(new Request(url(source))).then((r) => r.status);
	try {
		setSystemTime(new Date("2026-01-01T00:00:00Z"));
		expect(await ask(FLOW)).toBe(422);
		expect(await ask("not a diagram")).toBe(422);
		expect(calls).toBe(2);
		setSystemTime(new Date("2026-01-01T00:05:00Z"));
		expect(await ask(FLOW)).toBe(422);
		setSystemTime(new Date("2026-01-01T00:11:00Z"));
		expect(await ask(FLOW)).toBe(200);
		expect(await ask("not a diagram")).toBe(422);
		expect(calls).toBe(3);
	} finally {
		setSystemTime();
	}
});
