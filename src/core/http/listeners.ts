import { chmodSync } from "node:fs";
import type { Server } from "bun";
import { PluginError } from "../errors.ts";
import type { Logger } from "../log.ts";
import { serveUnix } from "../shared/unix-server.ts";

/** A handler a plugin attaches to one of the host's configured listeners. */
export interface HttpRoute {
	name: string;
	/** The configured listener it attaches to; a route never creates one. */
	listener: string;
	path: { exact: string } | { prefix: string };
	/** Omitted: every method, for a handler that answers the rest itself. */
	methods?: readonly string[];
	handle(request: Request): Response | Promise<Response>;
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

/** Refuses routes on unknown listeners, reused names, and any request two routes could both take. */
function validate(
	listeners: readonly ListenerConfig[],
	routes: readonly HttpRoute[],
): void {
	const ids = new Set(listeners.map((l) => l.id));
	if (ids.size !== listeners.length)
		throw new PluginError("a listener is configured twice");
	routes.forEach((route, index) => {
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
	// pi-lens-ignore: unchecked-throwing-call -- the server builds request.url, always an absolute URL
	const path = new URL(request.url).pathname;
	const route = routes.find(
		(r) =>
			matches(r, path) && (!r.methods || r.methods.includes(request.method)),
	);
	if (!route) return new Response("Not found", { status: 404 });
	try {
		return await route.handle(request);
	} catch (err) {
		logger.error({ err, route: route.name, listener }, "route failed");
		return serverError();
	}
}

/** Serves HTTP on a TCP port with the same idle setting as the unix sockets. */
function serveTcp(
	port: number,
	hostname: string | undefined,
	fetch: (request: Request) => Response | Promise<Response>,
): Server<undefined> {
	return Bun.serve({
		port,
		...(hostname ? { hostname } : {}),
		idleTimeout: 0,
		fetch,
		error: serverError,
	});
}

/** The host's HTTP listeners, each serving only the routes attached to it. */
// pi-lens-ignore: large-class — three members: validation in the constructor, start, and stop
export class HttpListeners {
	readonly #listeners: readonly ListenerConfig[];
	readonly #routes: readonly HttpRoute[];
	readonly #logger: Logger;
	#servers: Server<undefined>[] = [];

	/** Validates every route before any socket opens. */
	constructor(
		listeners: readonly ListenerConfig[],
		routes: readonly HttpRoute[],
		logger: Logger,
	) {
		validate(listeners, routes);
		this.#logger = logger;
		this.#listeners = listeners;
		this.#routes = routes;
	}

	/** Opens every listener; when one fails, the ones already open close again before the error is thrown. */
	start(): void {
		try {
			for (const listener of this.#listeners) {
				const routes = this.#routes.filter(
					(route) => route.listener === listener.id,
				);
				const handle = (request: Request) =>
					routeRequest(routes, request, listener.id, this.#logger);
				if ("socketPath" in listener) {
					this.#servers.push(
						serveUnix(listener.socketPath, handle, { error: serverError }),
					);
					chmodSync(listener.socketPath, listener.mode ?? 0o660);
				} else {
					this.#servers.push(
						serveTcp(listener.port, listener.hostname, handle),
					);
				}
			}
		} catch (error) {
			this.stop();
			throw error;
		}
	}

	/** Stops accepting at once and cuts open connections, such as event streams, without waiting on them. */
	stop(): void {
		for (const server of this.#servers) void server.stop(true);
		this.#servers = [];
	}
}
