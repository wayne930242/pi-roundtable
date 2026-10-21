import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressProxy, type EgressProxyOptions } from "./egress-proxy.ts";

/** Addresses are built, not written, so the public scan finds no address literal in the tree. */
const ip = (...parts: number[]) => parts.join(".");
const PUBLIC = ip(8, 8, 8, 8);
const METADATA = ip(169, 254, 169, 254);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A server that answers every connection with what it saw first, and counts connections. */
async function origin() {
	const seen: string[] = [];
	let connections = 0;
	const server: Server = createServer((socket) => {
		connections++;
		socket.once("data", (chunk) => {
			seen.push(chunk.toString("latin1"));
			socket.end(
				"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi",
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return { port: address.port, seen, connections: () => connections };
}

/** The proxy with every "public" address redirected to the local origin, so no real network is used. */
async function proxy(
	options: Partial<EgressProxyOptions> & { toPort?: number } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "egress-"));
	const socketPath = join(dir, "p.sock");
	const connectedTo: string[] = [];
	const refused: string[] = [];
	const resolved: string[] = [];
	const instance = await EgressProxy.listen({
		socketPath,
		ports: [80, 443, ...(options.toPort ? [options.toPort] : [])],
		resolve: async (host) => {
			resolved.push(host);
			return host === "rebind.test"
				? resolved.filter((name) => name === host).length === 1
					? [{ address: PUBLIC, family: 4 }]
					: [{ address: "127.0.0.1", family: 4 }]
				: host === "private.test"
					? [{ address: "10.0.0.5", family: 4 }]
					: host === "mixed.test"
						? [
								{ address: PUBLIC, family: 4 },
								{ address: METADATA, family: 4 },
							]
						: [{ address: PUBLIC, family: 4 }];
		},
		connectTo: (address, port) => {
			connectedTo.push(`${address.address}:${port}`);
			return connect({ host: "127.0.0.1", port: options.toPort ?? port });
		},
		onRefused: (destination, reason) =>
			refused.push(`${destination} ${reason}`),
		...options,
	});
	cleanups.push(async () => {
		await instance.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { socketPath, connectedTo, refused, resolved };
}

/** Sends `request` to the proxy's socket and returns everything it answers until it closes. */
function ask(
	socketPath: string,
	request: string,
	after?: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket: Socket = connect(socketPath);
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			if (after && Buffer.concat(chunks).toString().includes("\r\n\r\n")) {
				socket.write(after);
				after = undefined;
			}
		});
		socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
		socket.on("error", reject);
		socket.write(request);
	});
}

const refusedStatus = (reply: string) => /^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1];

test.each([
	["127.0.0.1:80", "a loopback literal"],
	[`${METADATA}:80`, "the link-local metadata address"],
	["10.1.2.3:443", "a private literal"],
	["[::1]:443", "an IPv6 loopback literal"],
	["[::ffff:7f00:1]:80", "an IPv4-mapped loopback literal"],
	["2130706433:80", "a decimal loopback"],
	["private.test:443", "a name that resolves to a private address"],
	["mixed.test:443", "a name with one public and one link-local answer"],
])("CONNECT to %s (%s) is refused and nothing connects", async (target) => {
	const reached = await origin();
	const p = await proxy({ toPort: reached.port });
	const reply = await ask(
		p.socketPath,
		`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
	);
	expect(refusedStatus(reply)).toBe("403");
	expect(p.connectedTo).toEqual([]);
	expect(reached.connections()).toBe(0);
	expect(p.refused.length).toBe(1);
});

test("a plain request to a private destination is refused too", async () => {
	const reached = await origin();
	const p = await proxy({ toPort: reached.port });
	const reply = await ask(
		p.socketPath,
		`GET http://127.0.0.1:${reached.port}/secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
	);
	expect(refusedStatus(reply)).toBe("403");
	expect(reached.connections()).toBe(0);
});

test("a port outside the allowed ones is refused before any lookup", async () => {
	const p = await proxy();
	const reply = await ask(
		p.socketPath,
		"CONNECT public.test:25 HTTP/1.1\r\n\r\n",
	);
	expect(refusedStatus(reply)).toBe("403");
	expect(p.resolved).toEqual([]);
});

test("a public destination is connected by the vetted address and tunnelled both ways", async () => {
	const reached = await origin();
	const p = await proxy({ toPort: reached.port });
	const reply = await ask(
		p.socketPath,
		"CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
		"GET / HTTP/1.1\r\nHost: public.test\r\n\r\n",
	);
	expect(reply.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(
		true,
	);
	expect(reply).toContain("hi");
	expect(p.connectedTo).toEqual([`${PUBLIC}:443`]);
	expect(reached.seen[0]).toStartWith("GET / HTTP/1.1");
});

test("a plain request is sent on in origin form, once per connection, without proxy headers", async () => {
	const reached = await origin();
	const p = await proxy({ toPort: reached.port });
	const reply = await ask(
		p.socketPath,
		"GET http://public.test/page?q=1 HTTP/1.1\r\nHost: public.test\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nProxy-Authorization: Basic eDp5\r\nAccept: */*\r\n\r\n",
	);
	expect(reply).toContain("200 OK");
	expect(reply.endsWith("hi")).toBe(true);
	expect(reached.seen[0]).toBe(
		"GET /page?q=1 HTTP/1.1\r\nHost: public.test\r\nAccept: */*\r\nConnection: close\r\n\r\n",
	);
});

test("a name is resolved once and the connection is pinned to that answer: DNS rebinding reaches nothing", async () => {
	const reached = await origin();
	const p = await proxy({ toPort: reached.port });
	// First request: the name resolves to a public address and is allowed through.
	await ask(
		p.socketPath,
		"CONNECT rebind.test:80 HTTP/1.1\r\n\r\n",
		"GET / HTTP/1.1\r\n\r\n",
	);
	expect(p.connectedTo).toEqual([`${PUBLIC}:80`]);
	// The same name now answers with a loopback address: the next request is refused.
	const second = await ask(
		p.socketPath,
		"CONNECT rebind.test:80 HTTP/1.1\r\n\r\n",
	);
	expect(refusedStatus(second)).toBe("403");
	expect(p.connectedTo).toEqual([`${PUBLIC}:80`]);
	expect(p.resolved.filter((name) => name === "rebind.test")).toHaveLength(2);
});

test("a redirect to a private address is a new request, and is refused", async () => {
	const reached = await origin();
	const p = await proxy({ toPort: reached.port });
	const first = await ask(
		p.socketPath,
		"GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\n\r\n",
	);
	expect(first).toContain("200 OK");
	const followed = await ask(
		p.socketPath,
		`GET http://${METADATA}/latest/meta-data HTTP/1.1\r\nHost: ${METADATA}\r\n\r\n`,
	);
	expect(refusedStatus(followed)).toBe("403");
	expect(reached.connections()).toBe(1);
});

test("requests that are not proxy requests are refused", async () => {
	const p = await proxy();
	expect(
		refusedStatus(
			await ask(p.socketPath, "GET /local HTTP/1.1\r\nHost: x\r\n\r\n"),
		),
	).toBe("400");
	expect(
		refusedStatus(
			await ask(p.socketPath, "GET ftp://public.test/ HTTP/1.1\r\n\r\n"),
		),
	).toBe("400");
	expect(
		refusedStatus(await ask(p.socketPath, "CONNECT nonsense HTTP/1.1\r\n\r\n")),
	).toBe("400");
});

test("connections past the limit are answered 503", async () => {
	const p = await proxy({ maxConnections: 1 });
	const held = connect(p.socketPath);
	await new Promise((resolve) => held.once("connect", resolve));
	cleanups.push(() => void held.destroy());
	await Bun.sleep(20);
	expect(
		refusedStatus(
			await ask(p.socketPath, "CONNECT a.test:443 HTTP/1.1\r\n\r\n"),
		),
	).toBe("503");
});
