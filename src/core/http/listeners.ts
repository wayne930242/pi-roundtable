import { chmodSync } from "node:fs";
import type { Server, WebSocketHandler } from "bun";
import { PluginError } from "../errors.ts";
import type { Logger } from "../log.ts";
import { serveUnix } from "../shared/unix-server.ts";
import {
	type Connection,
	DEFAULT_MAX_BUFFERED_BYTES,
	DEFAULT_MAX_MESSAGE_BYTES,
	isUpgrade,
	SocketSet,
	type WebSocketRoute,
} from "./websocket.ts";

/** A handler a plugin attaches to one of the host's configured listeners. */
export interface HttpRoute {
	name: string;
	/** The configured listener it attaches to; a route never creates one. */
	listener: string;
	path: { exact: string } | { prefix: string };
	/** Omitted: every method, for a handler that answers the rest itself. */
	methods?: readonly string[];
	handle(request: Request): Response | Promise<Response>;
	/**
	 * Takes the route's WebSocket upgrade requests (GET with `Upgrade: websocket`); every other
	 * request still reaches `handle`.
	 */
	websocket?: WebSocketRoute;
}

/** Where a listener serves: a unix socket, reached from outside through a tunnel, or a TCP port. */
export type ListenerAddress =
	| {
			socketPath: string;
			/** The socket file's permission bits; default `0o660`, so only its owner and group connect. */
			mode?: number;
	  }
	| { port: number; hostname?: string };

/** An address the host serves HTTP on, with the id routes name it by. */
export type ListenerConfig = { id: string } & ListenerAddress;

const pathOf = (route: HttpRoute) =>
	"exact" in route.path ? route.path.exact : route.path.prefix;

const matches = (route: HttpRoute, path: string) =>
	"exact" in route.path
		? path === route.path.exact
		: path.startsWith(route.path.prefix);

/** Whether one request could match both routes. */
function overlaps(a: HttpRoute, b: HttpRoute): boolean {
	const methods =
		!a.methods || !b.methods || a.methods.some((m) => b.methods?.includes(m));
	if (!methods) return false;
	// Each side's path is a request path the other may match.
	return matches(a, pathOf(b)) || matches(b, pathOf(a));
}

/** A non-special scheme's origin, such as `chrome-extension://<id>`, which URL reports as "null". */
const OPAQUE_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@:\s]+(?::\d+)?$/;

/**
 * Whether `origin` is `scheme://host[:port]` exactly as a browser sends it: a special scheme's
 * origin, or a non-special one in lowercase without path, query, fragment, or user.
 */
const isOrigin = (origin: string) => {
	const url = URL.parse(origin);
	if (!url) return false;
	return url.origin === "null"
		? OPAQUE_ORIGIN.test(origin)
		: url.origin === origin;
};

/** Refuses a WebSocket limit that is not a positive integer, naming the route and field. */
function validateLimits(name: string, websocket: WebSocketRoute): void {
	const limits: [string, number | undefined][] = [
		["maxMessageBytes", websocket.maxMessageBytes],
		["maxBufferedBytes", websocket.maxBufferedBytes],
		["maxConnections", websocket.maxConnections],
		["rate.messages", websocket.rate?.messages],
		["rate.perMs", websocket.rate?.perMs],
	];
	for (const [field, value] of limits)
		if (value !== undefined && !(Number.isSafeInteger(value) && value > 0))
			throw new PluginError(
				`route ${name} sets websocket ${field} to ${value}, which is not a positive integer`,
			);
}

/** Refuses routes on unknown listeners, reused names, and any request two routes could both take. */
function validate(
	listeners: readonly ListenerConfig[],
	routes: readonly HttpRoute[],
): void {
	const ids = new Set(listeners.map((l) => l.id));
	if (ids.size !== listeners.length)
		throw new PluginError("a listener is configured twice");
	routes.forEach((route, index) => {
		if (route.websocket && route.methods && !route.methods.includes("GET"))
			throw new PluginError(
				`route ${route.name} takes WebSockets, so its methods must include GET`,
			);
		if (route.websocket) validateLimits(route.name, route.websocket);
		const { origins } = route.websocket ?? {};
		if (origins && origins !== "any")
			for (const origin of origins)
				if (!isOrigin(origin))
					throw new PluginError(
						`route ${route.name} lists origin ${JSON.stringify(origin)}, which is not a scheme://host[:port] origin`,
					);
		if (!ids.has(route.listener))
			throw new PluginError(
				`route ${route.name} needs listener ${route.listener}, which is not configured`,
			);
		for (const other of routes.slice(0, index)) {
			if (other.name === route.name)
				throw new PluginError(`route ${route.name} is registered twice`);
			if (other.listener === route.listener && overlaps(other, route))
				throw new PluginError(
					`routes ${other.name} and ${route.name} overlap on listener ${route.listener}`,
				);
		}
	});
}

const serverError = () =>
	new Response("Internal Server Error", { status: 500 });

/** The route that takes a request, when one does. */
const routeFor = (routes: readonly HttpRoute[], request: Request) => {
	// pi-lens-ignore: unchecked-throwing-call -- the server builds request.url, always an absolute URL
	const path = new URL(request.url).pathname;
	return routes.find(
		(r) =>
			matches(r, path) && (!r.methods || r.methods.includes(request.method)),
	);
};

/**
 * Routes one listener's request; a request no route takes is 404, and a route that throws, or
 * whose promise rejects, is 500 with a fixed body. The failure is logged with the route's name
 * and listener, never the URL, since paths may hold tokens.
 */
export async function routeRequest(
	routes: readonly HttpRoute[],
	request: Request,
	listener: string,
	logger: Logger,
): Promise<Response> {
	const route = routeFor(routes, request);
	if (!route) return new Response("Not found", { status: 404 });
	try {
		return await route.handle(request);
	} catch (err) {
		logger.error({ err, route: route.name, listener }, "route failed");
		return serverError();
	}
}

/** What every request on one listener is served with. */
interface ListenerContext {
	listener: string;
	logger: Logger;
	sockets: SocketSet;
}

/**
 * Routes one listener's request like `routeRequest`, except that a WebSocket upgrade for a route
 * that takes them goes to its `websocket`; a failing `accept` answers and logs like a failing
 * `handle`. Answers nothing once the socket is upgraded.
 */
async function serveRequest(
	routes: readonly HttpRoute[],
	request: Request,
	server: Server<Connection>,
	{ listener, logger, sockets }: ListenerContext,
): Promise<Response | undefined> {
	const route = routeFor(routes, request);
	if (!route?.websocket || !isUpgrade(request))
		return routeRequest(routes, request, listener, logger);
	try {
		return await sockets.upgrade(route.name, route.websocket, request, server);
	} catch (err) {
		logger.error({ err, route: route.name, listener }, "route failed");
		return serverError();
	}
}

type Fetch = (
	request: Request,
	server: Server<Connection>,
) => Promise<Response | undefined>;

/** Serves HTTP on a TCP port with the same idle setting as the unix sockets. */
function serveTcp(
	port: number,
	hostname: string | undefined,
	fetch: Fetch,
	websocket: WebSocketHandler<Connection> | undefined,
): Server<Connection> {
	const options = {
		port,
		...(hostname ? { hostname } : {}),
		idleTimeout: 0,
		fetch,
		error: serverError,
		...(websocket ? { websocket } : {}),
	};
	// SAFETY: a listener without WebSocket routes passes no handler and never upgrades.
	return Bun.serve(
		options as Parameters<typeof Bun.serve<Connection>>[0],
	) as Server<Connection>;
}

/** How long a stop waits for WebSocket routes' handlers to settle before it returns anyway. */
const CLOSE_TIMEOUT_MS = 5_000;

/** The host's HTTP listeners, each serving only the routes attached to it. */
// pi-lens-ignore: large-class — four members: validation in the constructor, start, the WebSocket handler, and stop
export class HttpListeners {
	readonly #listeners: readonly ListenerConfig[];
	readonly #routes: readonly HttpRoute[];
	readonly #logger: Logger;
	readonly #sockets: SocketSet;
	readonly #closeTimeoutMs: number;
	#servers: Pick<Server<unknown>, "stop">[] = [];

	/** Validates every route before any socket opens; `closeTimeoutMs` bounds how long a stop waits on WebSocket handlers. */
	constructor(
		listeners: readonly ListenerConfig[],
		routes: readonly HttpRoute[],
		logger: Logger,
		options: { closeTimeoutMs?: number } = {},
	) {
		validate(listeners, routes);
		this.#logger = logger;
		this.#listeners = listeners;
		this.#routes = routes;
		this.#sockets = new SocketSet(logger);
		this.#closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
	}

	/** Opens every listener; when one fails, the ones already open close again before the error is thrown. */
	start(): void {
		try {
			for (const listener of this.#listeners) {
				const routes = this.#routes.filter(
					(route) => route.listener === listener.id,
				);
				const handle: Fetch = (request, server) =>
					serveRequest(routes, request, server, {
						listener: listener.id,
						logger: this.#logger,
						sockets: this.#sockets,
					});
				const websocket = this.#websocketHandler(listener.id, routes);
				if ("socketPath" in listener) {
					this.#servers.push(
						websocket
							? serveUnix(listener.socketPath, handle, {
									error: serverError,
									websocket,
								})
							: serveUnix(
									listener.socketPath,
									(request) =>
										routeRequest(routes, request, listener.id, this.#logger),
									{ error: serverError },
								),
					);
					chmodSync(listener.socketPath, listener.mode ?? 0o660);
				} else {
					this.#servers.push(
						serveTcp(listener.port, listener.hostname, handle, websocket),
					);
				}
			}
		} catch (error) {
			void this.stop();
			throw error;
		}
	}

	/** The listener's WebSocket handler, sized for its largest route limits; none without WebSocket routes. */
	#websocketHandler(
		listener: string,
		routes: readonly HttpRoute[],
	): WebSocketHandler<Connection> | undefined {
		const websockets = routes.flatMap((route) =>
			route.websocket ? [route.websocket] : [],
		);
		if (websockets.length === 0) return undefined;
		return this.#sockets.handler(listener, {
			maxMessageBytes: Math.max(
				...websockets.map(
					(w) => w.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
				),
			),
			maxBufferedBytes: Math.max(
				...websockets.map(
					(w) => w.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
				),
			),
		});
	}

	/**
	 * Stops accepting at once and cuts open connections, such as event streams, without waiting on
	 * them. Open WebSockets get close code 1001 first, and the stop resolves once their routes'
	 * handlers have settled, or after the close timeout.
	 */
	async stop(): Promise<void> {
		this.#sockets.closeAll();
		for (const server of this.#servers) void server.stop(true);
		this.#servers = [];
		await this.#sockets.drain(this.#closeTimeoutMs);
	}
}
