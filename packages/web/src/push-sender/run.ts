import type { Server, SQL } from "bun";
import type { Logger } from "pi-roundtable";
import { ConsoleHttpError, json } from "../http.ts";
import { DeviceRoutes } from "../push/api.ts";
import { OutboxSender, type PushTransport } from "../push/drain.ts";
import { EndpointPolicy } from "../push/endpoint.ts";
import { type OutboxRow, PushOutbox } from "../push/outbox.ts";
import { PushSubscriptions } from "../push/subscriptions.ts";

export interface PushSenderOptions {
	/**
	 * The sender's own database role. It needs to SELECT the outbox, subscriptions, sessions and
	 * principals, UPDATE the outbox, and INSERT deliveries and subscriptions.
	 */
	database: SQL;
	/** Tried in order for each row until one says `sent`; a row's `via` narrows them. */
	transports: readonly PushTransport[];
	/** Words a row; with `push.content: "none"` the row carries no text, so this is where it comes from. */
	render(row: OutboxRow): { title: string; body?: string };
	/** Serves the subscription routes at `path`, for `push.sender.external.subscribePath`. */
	subscribe?: {
		listener: { port: number; hostname?: string } | { socketPath: string };
		/** The path the page posts devices to, such as `/push/subscriptions`. */
		path: string;
		/** Every request that is not a GET must carry exactly this `Origin`: the console's. */
		origin: string;
		/** The principal behind the request's session cookie, or undefined (use `webSessionPrincipal`). */
		authenticate(request: Request): Promise<string | undefined>;
		/** Push services besides the browsers' own, as `push.endpointHosts` writes them. */
		endpointHosts?: readonly string[];
	};
	logger: Logger;
	/** How often the outbox is looked at; default 1 s. */
	intervalMs?: number;
}

/**
 * Runs the process that signs and sends the app's pushes when the app holds no key
 * (`push.sender.external`). It empties the outbox through the transports and, when asked, serves
 * the subscription routes with the app's session cookie and the console's `Origin`.
 */
export function runPushSender(options: PushSenderOptions): {
	stop(): Promise<void>;
	/** Takes and sends what is queued now, for a test; returns how many rows it finished. */
	drain(): Promise<number>;
	/** The port the subscription routes listen on, when they are served over TCP. */
	port?: number;
} {
	const sender = new OutboxSender({
		outbox: new PushOutbox(options.database),
		transports: options.transports,
		render: options.render,
		logger: options.logger,
		...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
	});
	sender.start();
	const server = options.subscribe ? serve(options) : undefined;
	return {
		stop: async () => {
			await server?.stop(true);
			await sender.stop();
		},
		drain: () => sender.drain(),
		...(server?.port ? { port: server.port } : {}),
	};
}

function serve(options: PushSenderOptions): Server<undefined> {
	const { subscribe, logger } = options;
	if (!subscribe) throw new Error("no subscribe options");
	const devices = new DeviceRoutes({
		policy: new EndpointPolicy(subscribe.endpointHosts),
		subscriptions: new PushSubscriptions(options.database),
		enabled: true,
	});
	const base = subscribe.path.replace(/\/$/, "");
	return Bun.serve({
		...("socketPath" in subscribe.listener
			? { unix: subscribe.listener.socketPath }
			: {
					port: subscribe.listener.port,
					hostname: subscribe.listener.hostname ?? "127.0.0.1",
				}),
		fetch: async (request) => {
			const path = URL.parse(request.url)?.pathname ?? "";
			if (path !== base && !path.startsWith(`${base}/`))
				return new Response("Not Found", { status: 404 });
			let id: string | undefined;
			try {
				id =
					path === base
						? undefined
						: decodeURIComponent(path.slice(base.length + 1));
			} catch {
				return json({ error: "There is no such device." }, 404);
			}
			// A page on a sibling host of the same site carries the cookie too; the Origin is what stops it.
			if (
				request.method !== "GET" &&
				request.headers.get("origin") !== subscribe.origin
			)
				return json({ error: "The request did not come from the app." }, 403);
			try {
				const principalId = await subscribe.authenticate(request);
				if (!principalId) return json({ error: "Sign in again." }, 401);
				return await devices.handle(request, id, principalId);
			} catch (error) {
				if (error instanceof ConsoleHttpError)
					return json({ error: error.message }, error.status);
				logger.error({ err: error }, "a subscription request failed");
				return json(
					{ error: "The sender could not complete the request." },
					500,
				);
			}
		},
	});
}
