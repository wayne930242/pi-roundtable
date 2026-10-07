import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { HttpListeners, type HttpRoute } from "./listeners.ts";
import type {
	RouteSocket,
	WebSocketRoute,
	WebSocketSendResult,
} from "./websocket.ts";

const ORIGIN = "https://chat.example.com";
const SECRET = "tok-9f3a";

interface Session {
	user: string;
}

/** A WebSocket route on `/ws` that admits the bearer of `?token=good` and echoes with the user's name. */
function chatRoute(
	overrides: Partial<WebSocketRoute<Session>> = {},
): HttpRoute {
	const websocket: WebSocketRoute<Session> = {
		origins: [ORIGIN],
		accept: (request) => {
			const token = URL.parse(request.url)?.searchParams.get("token");
			if (!token) return new Response("Unauthorized", { status: 401 });
			if (token !== "good") return new Response("Forbidden", { status: 403 });
			return { data: { user: "ana" } };
		},
		message: (socket, message) => {
			socket.send(`${socket.data.user}: ${message}`);
		},
		...overrides,
	};
	return {
		name: "chat",
		listener: "public",
		path: { exact: "/ws" },
		handle: () => new Response("page"),
		websocket,
	};
}

function refused(build: () => unknown): unknown {
	try {
		build();
		return undefined;
	} catch (error) {
		return error;
	}
}

let running: HttpListeners | undefined;
afterEach(async () => {
	await running?.stop();
	running = undefined;
});

/** Starts a TCP listener with `routes` on a free port and returns its port. */
function serve(
	routes: HttpRoute[],
	logger = silentLogger(),
	options?: { closeTimeoutMs?: number },
): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port ?? 0;
	void probe.stop(true);
	running = new HttpListeners(
		[{ id: "public", port, hostname: "127.0.0.1" }],
		routes,
		logger,
		options,
	);
	running.start();
	return port;
}

/** A client socket that collects what it receives and how it closed. */
function connect(
	port: number,
	query = "?token=good",
	origin: string | null = ORIGIN,
) {
	// Bun's client takes headers in place of protocols; without an origin it sends none.
	const socket = new WebSocket(
		`ws://127.0.0.1:${port}/ws${query}`,
		(origin ? { headers: { origin } } : {}) as unknown as string[],
	);
	const received: string[] = [];
	socket.addEventListener("message", (event) => {
		received.push(String(event.data));
	});
	const opened = new Promise<boolean>((resolve) => {
		socket.addEventListener("open", () => resolve(true));
		socket.addEventListener("error", () => resolve(false));
	});
	const closed = new Promise<number>((resolve) => {
		socket.addEventListener("close", (event) => resolve(event.code));
	});
	const next = async (count: number) => {
		while (received.length < count) await Bun.sleep(5);
		return received.slice(0, count);
	};
	return { socket, opened, closed, received, next };
}

const UPGRADE_HEADERS = {
	connection: "Upgrade",
	upgrade: "websocket",
	"sec-websocket-version": "13",
	"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

/** The status the server answers an upgrade request with, read as plain HTTP. */
async function handshake(
	port: number,
	query: string,
	origin: string | null = ORIGIN,
	init: { method?: string; headers?: Record<string, string> } = {},
): Promise<[number, string]> {
	const response = await fetch(`http://127.0.0.1:${port}/ws${query}`, {
		method: init.method ?? "GET",
		headers: {
			...(init.headers ?? UPGRADE_HEADERS),
			...(origin ? { origin } : {}),
		},
	});
	return [response.status, await response.text()];
}

/**
 * A raw client that completes the handshake and then stops reading, so whatever the server
 * sends piles up. `ended` resolves with the bytes it held once the server cut the connection.
 */
function stalledClient(port: number) {
	const socket = connectTcp(port, "127.0.0.1");
	const chunks: Buffer[] = [];
	socket.on("connect", () => {
		socket.write(
			`GET /ws?token=good HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\n${Object.entries(
				UPGRADE_HEADERS,
			)
				.map(([name, value]) => `${name}: ${value}\r\n`)
				.join("")}\r\n`,
		);
		socket.pause();
	});
	socket.on("data", (chunk: Buffer) => chunks.push(chunk));
	const ended = new Promise<Buffer>((resolve) => {
		socket.on("close", () => resolve(Buffer.concat(chunks)));
	});
	return { resume: () => socket.resume(), ended };
}

describe("a WebSocket route", () => {
	test("upgrades with the data accept gave, and plain requests still reach handle", async () => {
		const port = serve([chatRoute()]);
		const client = connect(port);
		expect(await client.opened).toBe(true);
		client.socket.send("hi");
		expect(await client.next(1)).toEqual(["ana: hi"]);
		const page = await fetch(`http://127.0.0.1:${port}/ws`);
		expect(await page.text()).toBe("page");
		client.socket.close();
	});

	test("serves on a unix-socket listener too", async () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "ws-")), "public.sock");
		running = new HttpListeners(
			[{ id: "public", socketPath }],
			[chatRoute({ origins: "any" })],
			silentLogger(),
		);
		running.start();
		const socket = new WebSocket(`ws+unix://${socketPath}:/ws?token=good`);
		const reply = new Promise<string>((resolve) => {
			socket.addEventListener("message", (event) =>
				resolve(String(event.data)),
			);
		});
		socket.addEventListener("open", () => socket.send("hi"));
		expect(await reply).toBe("ana: hi");
		socket.close();
	});

	test("must take GET, the method an upgrade comes with", () => {
		const build = () =>
			new HttpListeners(
				[{ id: "public", port: 0 }],
				[{ ...chatRoute(), methods: ["POST"] }],
				silentLogger(),
			);
		expect(build).toThrow(PluginError);
	});

	test("must list each origin as scheme://host[:port], exactly as a browser sends it", () => {
		for (const origin of [
			"https://chat.example.com/",
			"chat.example.com",
			"https://chat.example.com/app",
			"HTTPS://chat.example.com",
			"null",
		]) {
			const error = refused(
				() =>
					new HttpListeners(
						[{ id: "public", port: 0 }],
						[chatRoute({ origins: [ORIGIN, origin] })],
						silentLogger(),
					),
			);
			expect(error).toBeInstanceOf(PluginError);
			expect(String(error)).toContain(JSON.stringify(origin));
		}
		expect(
			new HttpListeners(
				[{ id: "public", port: 0 }],
				[chatRoute({ origins: [ORIGIN, "http://localhost:5173"] })],
				silentLogger(),
			),
		).toBeInstanceOf(HttpListeners);
	});

	test("routes a request that is no complete WebSocket handshake to handle, never accept", async () => {
		let asked = 0;
		const port = serve([
			chatRoute({
				accept: () => {
					asked += 1;
					return { data: { user: "ana" } };
				},
			}),
		]);
		// Not a GET: an ordinary request for the route's handler.
		expect(
			await handshake(port, "?token=good", ORIGIN, { method: "POST" }),
		).toEqual([200, "page"]);
		// A GET asking for a WebSocket without a key or with another version is malformed.
		const { "sec-websocket-key": _, ...keyless } = UPGRADE_HEADERS;
		expect(
			await handshake(port, "?token=good", ORIGIN, { headers: keyless }),
		).toEqual([400, "Bad Request"]);
		expect(
			await handshake(port, "?token=good", ORIGIN, {
				headers: { ...UPGRADE_HEADERS, "sec-websocket-version": "8" },
			}),
		).toEqual([400, "Bad Request"]);
		expect(asked).toBe(0);
	});

	test("refuses upgrades past maxConnections with 503 before accept", async () => {
		let asked = 0;
		const port = serve([
			chatRoute({
				maxConnections: 2,
				accept: () => {
					asked += 1;
					return { data: { user: "ana" } };
				},
			}),
		]);
		const first = connect(port);
		const second = connect(port);
		expect([await first.opened, await second.opened]).toEqual([true, true]);
		expect(asked).toBe(2);
		expect(await handshake(port, "?token=good")).toEqual([
			503,
			"Service Unavailable",
		]);
		expect(await connect(port).opened).toBe(false);
		expect(asked).toBe(2);
		first.socket.close();
		await first.closed;
		// A closed socket frees its place.
		let third = connect(port);
		while (!(await third.opened)) {
			await Bun.sleep(5);
			third = connect(port);
		}
		expect(asked).toBe(3);
		second.socket.close();
		third.socket.close();
	});

	test("refuses before the upgrade with the response accept returned", async () => {
		const port = serve([chatRoute()]);
		expect(await handshake(port, "")).toEqual([401, "Unauthorized"]);
		expect(await handshake(port, "?token=bad")).toEqual([403, "Forbidden"]);
		expect(await connect(port, "?token=bad").opened).toBe(false);
	});

	test("refuses an Origin outside the allowlist without asking accept", async () => {
		let asked = 0;
		const port = serve([
			chatRoute({
				accept: () => {
					asked += 1;
					return { data: { user: "ana" } };
				},
			}),
		]);
		expect(await handshake(port, "", "https://evil.example")).toEqual([
			403,
			"Forbidden",
		]);
		expect(await handshake(port, "", null)).toEqual([403, "Forbidden"]);
		expect(asked).toBe(0);
		expect(await connect(port, "", "https://evil.example").opened).toBe(false);
		expect(asked).toBe(0);
	});

	test('takes any Origin, or none, when origins is "any"', async () => {
		const port = serve([chatRoute({ origins: "any" })]);
		expect(await connect(port, "?token=good", "https://elsewhere").opened).toBe(
			true,
		);
		expect(await connect(port, "?token=good", null).opened).toBe(true);
	});

	test("closes a socket whose message is over the size limit, and keeps serving", async () => {
		const port = serve([chatRoute({ maxMessageBytes: 8 })]);
		const big = connect(port);
		expect(await big.opened).toBe(true);
		big.socket.send("x".repeat(9));
		expect(await big.closed).toBe(1009);
		expect(big.received).toEqual([]);
		// Multibyte text counts in bytes: three characters, nine bytes.
		const wide = connect(port);
		expect(await wide.opened).toBe(true);
		wide.socket.send("\u4f60\u597d\u55ce");
		expect(await wide.closed).toBe(1009);
		// Far over the limit, the server drops the connection before reading the message.
		const huge = connect(port);
		expect(await huge.opened).toBe(true);
		huge.socket.send("x".repeat(17));
		expect(await huge.closed).toBe(1006);
		const fine = connect(port);
		expect(await fine.opened).toBe(true);
		fine.socket.send("12345678");
		expect(await fine.next(1)).toEqual(["ana: 12345678"]);
		fine.socket.close();
	});

	test("cuts a client that stops reading once maxBufferedBytes wait, and says so to the route", async () => {
		const results: WebSocketSendResult[] = [];
		let closedWith: number | undefined;
		let afterClose: WebSocketSendResult | undefined;
		const port = serve([
			chatRoute({
				maxBufferedBytes: 64 * 1024,
				open: (socket) => {
					const chunk = "x".repeat(16 * 1024);
					for (let n = 0; n < 100_000; n += 1) {
						const result = socket.send(chunk);
						results.push(result);
						if (result === "dropped") break;
					}
				},
				close: (socket, code) => {
					closedWith = code;
					afterClose = socket.send("late");
				},
			}),
		]);
		const client = stalledClient(port);
		while (closedWith === undefined) await Bun.sleep(5);
		expect(results.at(-1)).toBe("dropped");
		expect(results.filter((result) => result === "dropped")).toHaveLength(1);
		expect(results).toContain("sent");
		expect(results).toContain("queued");
		// The socket is cut without a close frame: 1006 on both sides.
		expect(closedWith).toBe(1006);
		expect(afterClose).toBe("dropped");
		client.resume();
		const held = await client.ended;
		// A close frame would start with 0x88; the stream ends with message bytes instead.
		expect(held.length).toBeGreaterThan(0);
		expect(held.at(-1)).toBe("x".charCodeAt(0));
	});

	test("send reports a message to a closed socket as dropped", async () => {
		let kept: RouteSocket<Session> | undefined;
		let closed = false;
		const port = serve([
			chatRoute({
				open: (socket) => {
					kept = socket;
				},
				close: () => {
					closed = true;
				},
			}),
		]);
		const client = connect(port);
		expect(await client.opened).toBe(true);
		expect(kept?.send("hello")).toBe("sent");
		expect(await client.next(1)).toEqual(["hello"]);
		client.socket.close();
		while (!closed) await Bun.sleep(5);
		expect(kept?.send("gone")).toBe("dropped");
	});

	test("closes a socket that sends faster than its rate", async () => {
		const port = serve([chatRoute({ rate: { messages: 3, perMs: 60_000 } })]);
		const client = connect(port);
		expect(await client.opened).toBe(true);
		for (const n of [1, 2, 3, 4, 5]) client.socket.send(String(n));
		expect(await client.closed).toBe(1008);
		expect(client.received).toEqual(["ana: 1", "ana: 2", "ana: 3"]);
	});

	test("a failing accept answers 500 with a fixed body and logs no URL", async () => {
		const { logger, lines } = recordingLogger();
		const port = serve(
			[
				chatRoute({
					accept: () => {
						throw new Error("boom");
					},
				}),
			],
			logger,
		);
		expect(await handshake(port, `?token=${SECRET}`)).toEqual([
			500,
			"Internal Server Error",
		]);
		const failures = lines.filter((line) => line.level === "error");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.fields).toMatchObject({
			route: "chat",
			listener: "public",
		});
		expect(failures[0]?.message).toBe("route failed");
		expect(JSON.stringify(lines)).not.toContain(SECRET);
	});

	test("a failing handler closes only its socket with 1011; the listener keeps serving", async () => {
		const { logger, lines } = recordingLogger();
		const port = serve(
			[
				chatRoute({
					message: (socket, message) => {
						if (message === "crash") throw new Error("boom");
						if (message === "reject") return Promise.reject(new Error("boom"));
						socket.send(`ok ${message}`);
					},
				}),
			],
			logger,
		);
		const bystander = connect(port);
		expect(await bystander.opened).toBe(true);
		for (const trigger of ["crash", "reject"]) {
			const client = connect(port);
			expect(await client.opened).toBe(true);
			client.socket.send(trigger);
			expect(await client.closed).toBe(1011);
		}
		bystander.socket.send("still here");
		expect(await bystander.next(1)).toEqual(["ok still here"]);
		expect(await (await fetch(`http://127.0.0.1:${port}/ws`)).text()).toBe(
			"page",
		);
		const failures = lines.filter((line) => line.level === "error");
		expect(failures).toHaveLength(2);
		expect(failures[0]?.fields).toMatchObject({
			route: "chat",
			listener: "public",
		});
		expect(failures[0]?.message).toBe("websocket handler failed");
		bystander.socket.close();
	});

	test("stop closes every socket with 1001 and waits for the route's close handlers", async () => {
		const closedBy: [string, number][] = [];
		const port = serve([
			chatRoute({
				close: async (socket: RouteSocket<Session>, code) => {
					await Bun.sleep(30);
					closedBy.push([socket.data.user, code]);
				},
			}),
		]);
		const clients = [connect(port), connect(port)];
		for (const client of clients) expect(await client.opened).toBe(true);
		const listeners = running;
		running = undefined;
		await listeners?.stop();
		expect(closedBy).toEqual([
			["ana", 1001],
			["ana", 1001],
		]);
		expect(await Promise.all(clients.map((c) => c.closed))).toEqual([
			1001, 1001,
		]);
		expect(await fetch(`http://127.0.0.1:${port}/ws`).catch(() => "down")).toBe(
			"down",
		);
	});

	test("stop gives up on a close handler that hangs past the timeout", async () => {
		const port = serve(
			[chatRoute({ close: () => new Promise<void>(() => {}) })],
			silentLogger(),
			{ closeTimeoutMs: 50 },
		);
		const client = connect(port);
		expect(await client.opened).toBe(true);
		const listeners = running;
		running = undefined;
		const started = Date.now();
		await listeners?.stop();
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
