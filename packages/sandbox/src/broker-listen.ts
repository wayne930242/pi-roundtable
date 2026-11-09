import { chmodSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";

export interface BrokerListener {
	stop(force?: boolean): Promise<void>;
}

export interface ListenOptions {
	/**
	 * Stream the response with backpressure instead of buffering it. Time is then bounded by
	 * the host's own signal in `handle` plus an idle limit on each body read and write.
	 */
	stream?: boolean;
	/** Idle limit between body chunks in stream mode. Default 120 000 ms. */
	idleMs?: number;
}

export async function listenBroker(
	socketPath: string,
	handle: (request: Request) => Promise<Response>,
	options: ListenOptions = {},
): Promise<BrokerListener> {
	const stream = options.stream === true;
	const idleMs = options.idleMs ?? 120_000;
	const sockets = new Set<Socket>();
	const headerTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
	const server = createServer(async (incoming, outgoing) => {
		clearTimeout(headerTimers.get(incoming.socket));
		headerTimers.delete(incoming.socket);
		const requestController = new AbortController();
		const expire = () => {
			requestController.abort();
			incoming.destroy();
			outgoing.destroy();
		};
		let requestTimer = setTimeout(expire, stream ? idleMs : 60_000);
		// Stream mode only limits silence: slow progress is allowed, a stalled peer is not.
		const touch = () => {
			if (!stream) return;
			clearTimeout(requestTimer);
			requestTimer = setTimeout(expire, idleMs);
		};
		const finish = () => {
			clearTimeout(requestTimer);
			requestController.abort();
		};
		if (stream) {
			incoming.on("data", touch);
			// The host handler may take as long as its own signal allows; only body silence is limited.
			incoming.once("end", () => clearTimeout(requestTimer));
			if (incoming.method === "GET" || incoming.method === "HEAD")
				clearTimeout(requestTimer);
		}
		outgoing.once("finish", finish);
		outgoing.once("close", finish);
		outgoing.on("error", () => outgoing.destroy());
		outgoing.setHeader("connection", "close");
		try {
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (value !== undefined)
					headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
			const request = new Request(`http://broker${incoming.url ?? "/"}`, {
				method: incoming.method ?? "GET",
				headers,
				signal: requestController.signal,
				...(incoming.method === "GET" || incoming.method === "HEAD"
					? {}
					: { body: Readable.toWeb(incoming), duplex: "half" }),
			});
			const response = await handle(request);
			if (stream) {
				if (outgoing.destroyed || outgoing.writableEnded) {
					await response.body?.cancel();
					return;
				}
				outgoing.writeHead(
					response.status,
					Object.fromEntries(response.headers),
				);
				touch();
				const reader = response.body?.getReader();
				outgoing.once("close", () => void reader?.cancel().catch(() => {}));
				for (;;) {
					const chunk = await reader?.read();
					if (!chunk || chunk.done) break;
					touch();
					if (outgoing.destroyed) break;
					if (!outgoing.write(chunk.value))
						await new Promise<void>((resolve) => {
							const done = () => {
								outgoing.off("drain", done);
								outgoing.off("close", done);
								resolve();
							};
							outgoing.once("drain", done);
							outgoing.once("close", done);
						});
				}
				if (!outgoing.destroyed) outgoing.end();
				return;
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (!outgoing.destroyed && !outgoing.writableEnded) {
				outgoing.writeHead(
					response.status,
					Object.fromEntries(response.headers),
				);
				outgoing.end(bytes);
			}
		} catch {
			if (outgoing.headersSent) outgoing.destroy();
			else if (!outgoing.destroyed && !outgoing.writableEnded) {
				outgoing.writeHead(400);
				outgoing.end("bad request");
			}
		}
	});
	server.on("connection", (socket) => {
		if (sockets.size >= 16) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		headerTimers.set(
			socket,
			setTimeout(() => socket.destroy(), 10_000),
		);
		socket.once("close", () => {
			sockets.delete(socket);
			clearTimeout(headerTimers.get(socket));
			headerTimers.delete(socket);
		});
	});
	server.maxConnections = 16;
	server.headersTimeout = 10_000;
	server.requestTimeout = stream ? 0 : 60_000;
	server.keepAliveTimeout = 1000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	try {
		chmodSync(socketPath, 0o600);
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw error;
	}
	return {
		stop: (force = true) =>
			new Promise<void>((resolve) => {
				if (force) {
					for (const socket of sockets) socket.destroy();
					server.closeAllConnections();
				}
				server.close(() => resolve());
			}),
	};
}
