import { chmodSync, rmSync } from "node:fs";
import type { Server } from "bun";
import { PluginError } from "../errors.ts";

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
	| { socketPath: string }
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

/** Routes one listener's request; a request no route takes is 404. The URL is never logged, since paths may hold tokens. */
export function routeRequest(
	routes: readonly HttpRoute[],
	request: Request,
): Response | Promise<Response> {
	// pi-lens-ignore: unchecked-throwing-call -- the server builds request.url, always an absolute URL
	const path = new URL(request.url).pathname;
	const route = routes.find(
		(r) =>
			matches(r, path) && (!r.methods || r.methods.includes(request.method)),
	);
	return route
		? route.handle(request)
		: new Response("Not found", { status: 404 });
}

/**
 * Serves HTTP on a unix socket without Bun's 10-second idle timeout, which would cut long
 * turns and quiet model streams. Bun 1.4.2 honors `idleTimeout` on unix sockets, but its
 * types reject the option there, hence the cast. A stale socket file is removed first.
 * (`shared/unix-server.ts` keeps its own copy for the party worker's image.)
 */
function serveUnix(
	socketPath: string,
	fetch: (request: Request) => Response | Promise<Response>,
): Server<undefined> {
	rmSync(socketPath, { force: true });
	const options = { unix: socketPath, idleTimeout: 0, fetch };
	// SAFETY: these are Bun's unix-socket options; only `idleTimeout` is missing from its types.
	return Bun.serve(
		options as unknown as Parameters<typeof Bun.serve>[0],
	) as Server<undefined>;
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
	});
}

/** The host's HTTP listeners, each serving only the routes attached to it. */
// pi-lens-ignore: large-class — three members: validation in the constructor, start, and stop
export class HttpListeners {
	readonly #listeners: readonly ListenerConfig[];
	readonly #routes: readonly HttpRoute[];
	#servers: Server<undefined>[] = [];

	/** Validates every route before any socket opens. */
	constructor(
		listeners: readonly ListenerConfig[],
		routes: readonly HttpRoute[],
	) {
		validate(listeners, routes);
		this.#listeners = listeners;
		this.#routes = routes;
	}

	start(): void {
		for (const listener of this.#listeners) {
			const routes = this.#routes.filter(
				(route) => route.listener === listener.id,
			);
			const handle = (request: Request) => routeRequest(routes, request);
			if ("socketPath" in listener) {
				this.#servers.push(serveUnix(listener.socketPath, handle));
				// cloudflared runs as another user in its container.
				chmodSync(listener.socketPath, 0o666);
			} else {
				this.#servers.push(serveTcp(listener.port, listener.hostname, handle));
			}
		}
	}

	/** Stops accepting at once and cuts open connections, such as event streams, without waiting on them. */
	stop(): void {
		for (const server of this.#servers) void server.stop(true);
		this.#servers = [];
	}
}
