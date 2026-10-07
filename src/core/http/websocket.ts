import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Logger } from "../log.ts";

/** One socket a WebSocket route accepted, with the data its `accept` gave. */
export interface RouteSocket<Data = unknown> {
	readonly data: Data;
	send(message: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
}

/** What `accept` answers: the socket's data to upgrade with, or a response that refuses it. */
export type WebSocketAccept<Data = unknown> =
	| { data: Data; headers?: Record<string, string> }
	| Response;

/**
 * The WebSocket half of an HTTP route. An upgrade request on the route's path passes the Origin
 * check, then `accept`, which authenticates it before any socket opens; other requests still
 * reach the route's `handle`.
 */
export interface WebSocketRoute<Data = unknown> {
	/**
	 * The `Origin` values a browser may connect from, each as `scheme://host[:port]`; a request
	 * with another Origin, or none, is refused with 403 before `accept`. `"any"` skips the check,
	 * for clients that are not browsers.
	 */
	origins: readonly string[] | "any";
	/** Authenticates and authorizes the upgrade; a thrown error answers 500 like a failing `handle`. */
	accept(
		request: Request,
	): WebSocketAccept<Data> | Promise<WebSocketAccept<Data>>;
	/**
	 * The largest message in bytes; a larger one closes the socket with 1009. Default 64 KiB. A
	 * message over twice the listener's largest limit drops the connection before it is read.
	 */
	maxMessageBytes?: number;
	/** At most `messages` per `perMs` from one socket; one more closes it with 1008. Default 120 a minute. */
	rate?: { messages: number; perMs: number };
	open?(socket: RouteSocket<Data>): void | Promise<void>;
	/** Called per message as it arrives, without waiting for the previous call to settle. */
	message(
		socket: RouteSocket<Data>,
		message: string | Uint8Array,
	): void | Promise<void>;
	/** Called once the socket closed, also when the listener stops (code 1001); stop waits for it. */
	close?(
		socket: RouteSocket<Data>,
		code: number,
		reason: string,
	): void | Promise<void>;
}

export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_RATE = { messages: 120, perMs: 60_000 };

/** The close codes RFC 6455 names for the reasons this module closes a socket. */
const GOING_AWAY = 1001;
const POLICY_VIOLATION = 1008;
const TOO_BIG = 1009;
const INTERNAL_ERROR = 1011;

/** What the server keeps on each socket: its route, the route's socket, and its rate window. */
export interface Connection {
	route: string;
	websocket: WebSocketRoute;
	data: unknown;
	socket?: RouteSocket;
	windowStart: number;
	count: number;
}

/** Whether the request asks to become a WebSocket. */
export const isUpgrade = (request: Request): boolean =>
	request.headers.get("upgrade")?.toLowerCase() === "websocket";

const originAllowed = (route: WebSocketRoute, origin: string | null) =>
	route.origins === "any" ||
	(origin !== null && route.origins.includes(origin));

const byteLength = (message: string | Uint8Array) =>
	typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;

/**
 * Upgrades a request for a WebSocket route: a refused Origin is 403, the response `accept`
 * returns is sent as it is, and a throwing `accept` is passed to the caller like a failing `handle`.
 * Answers nothing once the socket is upgraded.
 */
export async function upgrade(
	name: string,
	websocket: WebSocketRoute,
	request: Request,
	server: Server<Connection>,
): Promise<Response | undefined> {
	if (!originAllowed(websocket, request.headers.get("origin")))
		return new Response("Forbidden", { status: 403 });
	const accepted = await websocket.accept(request);
	if (accepted instanceof Response) return accepted;
	const connection: Connection = {
		route: name,
		websocket,
		data: accepted.data,
		windowStart: Date.now(),
		count: 0,
	};
	const upgraded = server.upgrade(request, {
		data: connection,
		...(accepted.headers ? { headers: accepted.headers } : {}),
	});
	return upgraded ? undefined : new Response("Bad Request", { status: 400 });
}

/** Resolves after `promise` settles or `ms` passes, whichever comes first. */
async function settledWithin(promise: Promise<unknown>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	clearTimeout(timer);
}

/**
 * The open sockets of one host's listeners and the handler calls still running on them. A route
 * handler that throws or rejects closes its socket with 1011 and logs the route and listener,
 * never the URL.
 */
export class SocketSet {
	readonly #open = new Set<ServerWebSocket<Connection>>();
	readonly #running = new Set<Promise<void>>();
	readonly #logger: Logger;

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	/**
	 * The Bun handler for one listener's sockets, given its largest route limit. Bun drops a frame
	 * over twice that unread; up to there each route's own limit closes with 1009.
	 */
	handler(
		listener: string,
		maxMessageBytes: number,
	): WebSocketHandler<Connection> {
		return {
			maxPayloadLength: maxMessageBytes * 2,
			open: (ws) => {
				this.#open.add(ws);
				const connection = ws.data;
				connection.socket = {
					data: connection.data,
					send: (message) => void ws.send(message),
					close: (code, reason) => ws.close(code, reason),
				};
				const { open } = connection.websocket;
				if (open) this.#run(ws, listener, (socket) => open(socket));
			},
			message: (ws, message) => {
				const connection = ws.data;
				const { websocket } = connection;
				const limit = websocket.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
				if (byteLength(message) > limit) {
					ws.close(TOO_BIG, "message too big");
					return;
				}
				const rate = websocket.rate ?? DEFAULT_RATE;
				const now = Date.now();
				if (now - connection.windowStart >= rate.perMs) {
					connection.windowStart = now;
					connection.count = 0;
				}
				connection.count += 1;
				if (connection.count > rate.messages) {
					ws.close(POLICY_VIOLATION, "too many messages");
					return;
				}
				this.#run(ws, listener, (socket) => websocket.message(socket, message));
			},
			close: (ws, code, reason) => {
				this.#open.delete(ws);
				const { close } = ws.data.websocket;
				if (close)
					this.#run(ws, listener, (socket) => close(socket, code, reason));
			},
		};
	}

	/** Runs one route handler, tracked until it settles; a failure closes the socket. */
	#run(
		ws: ServerWebSocket<Connection>,
		listener: string,
		call: (socket: RouteSocket) => void | Promise<void>,
	): Promise<void> {
		const connection = ws.data;
		const running = (async () => {
			try {
				if (connection.socket) await call(connection.socket);
			} catch (err) {
				this.#logger.error(
					{ err, route: connection.route, listener },
					"websocket handler failed",
				);
				ws.close(INTERNAL_ERROR, "internal error");
			}
		})();
		this.#running.add(running);
		void running.finally(() => this.#running.delete(running));
		return running;
	}

	/** Closes every open socket with 1001, so each route's `close` runs. */
	closeAll(): void {
		for (const ws of this.#open) ws.close(GOING_AWAY, "server stopping");
	}

	/**
	 * Waits, at most `timeoutMs`, until every socket has closed and every handler call has settled;
	 * a close the server reports later, or a call it starts meanwhile, is waited for too.
	 */
	async drain(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.#open.size > 0 || this.#running.size > 0) {
			const left = deadline - Date.now();
			if (left <= 0) {
				this.#logger.warn(
					{ open: this.#open.size, running: this.#running.size },
					"websocket handlers still running after the close timeout",
				);
				return;
			}
			await settledWithin(
				Promise.allSettled([...this.#running]),
				Math.min(left, 10),
			);
		}
	}
}
