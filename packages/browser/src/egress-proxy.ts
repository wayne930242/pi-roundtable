import { lookup } from "node:dns/promises";
import { chmodSync } from "node:fs";
import {
	connect,
	createServer,
	isIP,
	type Server,
	type Socket,
} from "node:net";
import { isPublicAddress } from "./address.ts";

export interface ResolvedAddress {
	address: string;
	family: number;
}

export interface EgressProxyOptions {
	/** The unix socket to listen on; the browser container reaches it through a mounted directory. */
	socketPath: string;
	/** Destination ports a request may use; default 80 and 443. */
	ports?: readonly number[];
	/** Connections open at once; the next one is answered 503. Default 128. */
	maxConnections?: number;
	/** A connection with no traffic for this long is closed; default 60 seconds. */
	idleMs?: number;
	/** The wait for a connection to a vetted address; default 10 seconds. */
	connectMs?: number;
	/** Bytes in both directions together, over the proxy's life; past it every connection closes. Default 512 MiB. */
	maxBytes?: number;
	/** Trusted test seam: resolve a name. */
	resolve?: (host: string) => Promise<readonly ResolvedAddress[]>;
	/** Trusted test seam: open the connection to an address already vetted. */
	connectTo?: (address: ResolvedAddress, port: number) => Socket;
	/** Told about each refused request, for the host's log: the destination and why. */
	onRefused?: (destination: string, reason: string) => void;
}

const MAX_HEAD_BYTES = 32 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");
const HOP_HEADERS = new Set([
	"connection",
	"proxy-connection",
	"proxy-authorization",
	"keep-alive",
	"upgrade",
	"te",
	"trailer",
]);

const NUMERIC_HOST = /^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$/i;

class Refusal extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** `host:port` or `[v6]:port`, with the brackets removed. */
function authority(text: string): { host: string; port: number } {
	const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^\s:/\\@[\]]+)):(\d{1,5})$/.exec(
		text,
	);
	if (!match) throw new Refusal(400, "the destination is not host:port");
	const port = Number(match[3]);
	if (port < 1 || port > 65535) throw new Refusal(400, "the port is not valid");
	return { host: (match[1] ?? match[2] ?? "").toLowerCase(), port };
}

/**
 * The browser's only way out. The container has no network of its own; its browser sends every
 * request here through a unix socket. Each destination is resolved by this process, every address
 * of the answer must be a public one, and the connection goes to one of those addresses, so a
 * name that later resolves elsewhere (DNS rebinding), a redirect, a subresource or a WebSocket to
 * a private, loopback or link-local address reaches nothing.
 */
export class EgressProxy {
	readonly #server: Server;
	readonly #sockets = new Set<Socket>();
	readonly #options: EgressProxyOptions;
	readonly #ports: ReadonlySet<number>;
	#bytes = 0;

	private constructor(options: EgressProxyOptions) {
		this.#options = options;
		this.#ports = new Set(options.ports ?? [80, 443]);
		this.#server = createServer((socket) => this.#accept(socket));
	}

	static async listen(options: EgressProxyOptions): Promise<EgressProxy> {
		const proxy = new EgressProxy(options);
		await new Promise<void>((resolve, reject) => {
			proxy.#server.once("error", reject);
			proxy.#server.listen(options.socketPath, () => {
				proxy.#server.off("error", reject);
				resolve();
			});
		});
		// The container runs as the host user; nobody else needs to connect.
		chmodSync(options.socketPath, 0o600);
		return proxy;
	}

	/** Stops listening and closes every open connection. */
	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	#accept(client: Socket): void {
		const full = this.#sockets.size >= (this.#options.maxConnections ?? 128);
		this.#track(client);
		if (full) {
			// Read and drop what the client sends, so its close is seen and the socket ends.
			client.resume();
			client.end(this.#answer(503, "too many connections"));
			return;
		}
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf(HEAD_END);
			if (end < 0) {
				if (head.length > MAX_HEAD_BYTES) client.destroy();
				return;
			}
			client.off("data", onData);
			client.pause();
			void this.#serve(
				client,
				head.subarray(0, end).toString("latin1"),
				head.subarray(end + HEAD_END.length),
			);
		};
		client.on("data", onData);
	}

	#track(socket: Socket): void {
		this.#sockets.add(socket);
		socket.setTimeout(this.#options.idleMs ?? 60_000, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => this.#sockets.delete(socket));
		socket.on("data", (chunk: Buffer) => {
			this.#bytes += chunk.length;
			if (this.#bytes > (this.#options.maxBytes ?? 512 * 1024 * 1024))
				for (const open of this.#sockets) open.destroy();
		});
	}

	#answer(status: number, message: string): string {
		if (status === 200) return "HTTP/1.1 200 Connection Established\r\n\r\n";
		const body = `${message}\n`;
		return `HTTP/1.1 ${status} Refused\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
	}

	async #serve(client: Socket, head: string, rest: Buffer): Promise<void> {
		let destination = "(unreadable request)";
		try {
			const [requestLine = "", ...lines] = head.split("\r\n");
			const [method = "", target = "", version = ""] = requestLine.split(" ");
			if (!/^HTTP\/1\.[01]$/.test(version) || !/^[A-Z]+$/.test(method))
				throw new Refusal(400, "not an HTTP proxy request");
			const connecting = method === "CONNECT";
			let host: string;
			let port: number;
			let path = "";
			if (connecting) ({ host, port } = authority(target));
			else {
				const url = this.#absolute(target);
				host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
				port = url.port ? Number(url.port) : 80;
				path = `${url.pathname}${url.search}`;
			}
			destination = `${host}:${port}`;
			if (!this.#ports.has(port))
				throw new Refusal(403, `port ${port} is not allowed`);
			const upstream = await this.#open(host, port);
			this.#track(upstream);
			upstream.on("error", () => client.destroy());
			client.on("close", () => upstream.destroy());
			if (connecting) client.write(this.#answer(200, ""));
			else upstream.write(rewrite(method, path, version, lines));
			if (rest.length > 0) upstream.write(rest);
			upstream.pipe(client);
			client.pipe(upstream);
		} catch (error) {
			const refusal =
				error instanceof Refusal
					? error
					: new Refusal(502, "the destination could not be reached");
			this.#options.onRefused?.(destination, refusal.message);
			client.resume();
			client.end(this.#answer(refusal.status, refusal.message));
		}
	}

	#absolute(target: string): URL {
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			throw new Refusal(400, "the request target is not an absolute http URL");
		}
		if (url.protocol !== "http:" || url.username || url.password)
			throw new Refusal(400, "only credential-free http URLs go through here");
		return url;
	}

	/** Resolves once, refuses any non-public answer, and connects to the vetted addresses in turn. */
	async #open(host: string, port: number): Promise<Socket> {
		const resolve =
			this.#options.resolve ??
			((name: string) => lookup(name, { all: true, verbatim: true }));
		let addresses: readonly ResolvedAddress[];
		if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
		else if (NUMERIC_HOST.test(host))
			// The system resolver reads 2130706433, 0x7f.1 and 0177.0.0.1 as IPv4 addresses.
			throw new Refusal(403, "the destination is not a public address");
		else {
			try {
				addresses = await resolve(host);
			} catch {
				throw new Refusal(502, "the name does not resolve");
			}
		}
		if (
			addresses.length === 0 ||
			addresses.some(
				(entry) =>
					!isPublicAddress(entry.address) ||
					isIP(entry.address) !== entry.family,
			)
		)
			throw new Refusal(403, "the destination is not a public address");
		for (const address of addresses) {
			const socket = await this.#connect(address, port);
			if (socket) return socket;
		}
		throw new Refusal(502, "no address of the destination could be reached");
	}

	#connect(
		address: ResolvedAddress,
		port: number,
	): Promise<Socket | undefined> {
		return new Promise((resolve) => {
			const socket = this.#options.connectTo
				? this.#options.connectTo(address, port)
				: connect({ host: address.address, port, family: address.family });
			const timer = setTimeout(() => {
				socket.destroy();
				resolve(undefined);
			}, this.#options.connectMs ?? 10_000);
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve(socket);
			});
			socket.once("error", () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(undefined);
			});
		});
	}
}

/** The request head sent on to the origin: origin-form, one request per connection. */
function rewrite(
	method: string,
	path: string,
	version: string,
	lines: readonly string[],
): string {
	const kept = lines.filter((line) => {
		const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
		return name !== "" && !HOP_HEADERS.has(name);
	});
	return `${[`${method} ${path || "/"} ${version}`, ...kept, "Connection: close"].join("\r\n")}\r\n\r\n`;
}
