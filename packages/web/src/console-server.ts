import type { HttpRoute, Logger } from "pi-roundtable";
import type { AssetBundle } from "./assets.ts";
import type { Authenticator, Unauthenticated } from "./auth/authenticator.ts";
import type { ConsoleApi } from "./console-api.ts";
import type { ConsolePresentation } from "./features.ts";
import { presentPage } from "./page-presentation.ts";

const encoder = new TextEncoder();
/** Changes closer together than this reach the page as one event. */
const COALESCE_MS = 250;
/** Events a stream may hold unread before its client is cut off; it reconnects and refetches. */
const STREAM_BACKLOG = 16;
/** Keeps the stream open through proxies that close streams idle for about a minute or two. */
const PING_MS = 30_000;
/** Open event streams; one more is refused, so a client cannot hold every connection. */
const MAX_STREAMS = 32;
const READ_METHODS = new Set(["GET", "HEAD"]);

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "same-origin",
};

const PAGE_HEADERS = {
	"content-type": "text/html;charset=utf-8",
	"cache-control": "no-cache",
	"content-security-policy":
		"default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export interface ConsoleServerOptions {
	/** The path the console is served under, without a trailing slash: `/console`. */
	mount: string;
	assets: AssetBundle;
	/** Checks every request under the mount, and answers the few paths that need no session. */
	authenticator: Authenticator;
	api: Pick<ConsoleApi, "handle">;
	/** Registers the listener with every source whose change the console shows. */
	subscribe(listener: () => void): void;
	logger: Logger;
	/** How long changes are gathered into one event; default 250 ms. Tests set it lower. */
	coalesceMs?: number;
	/** Serve client page paths as the same authenticated document. */
	pathRouting?: boolean;
	presentation?: ConsolePresentation;
}

/**
 * The console on the host's listener: `<mount>` redirects to `<mount>/`, and everything under
 * it needs the authenticator to admit the request as an owner's, apart from what it answers
 * openly, such as a login page. A request that changes data must also carry the console's own
 * `Origin`.
 */
export class ConsoleServer {
	readonly #options: ConsoleServerOptions;
	readonly #base: string;
	readonly #streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	#pending: ReturnType<typeof setTimeout> | undefined;
	#ping: ReturnType<typeof setInterval> | undefined;

	constructor(options: ConsoleServerOptions) {
		this.#options = options;
		this.#base = `${options.mount}/`;
		options.subscribe(() => this.#changed());
	}

	routes(listener: string): HttpRoute[] {
		const handle = (request: Request) => this.handle(request);
		return [
			{
				name: "web-console-redirect",
				listener,
				path: { exact: this.#options.mount },
				handle,
			},
			{
				name: "web-console",
				listener,
				path: { prefix: this.#base },
				handle,
			},
		];
	}

	start(): void {
		this.#ping = setInterval(() => this.#send(": ping\n\n"), PING_MS);
	}

	/** Ends the event streams; the listener may already have closed their connections. */
	stop(): void {
		clearInterval(this.#ping);
		clearTimeout(this.#pending);
		this.#pending = undefined;
		for (const stream of this.#streams) {
			try {
				stream.close();
			} catch {
				// Its connection is gone, and the stream with it.
			}
		}
		this.#streams.clear();
	}

	async handle(request: Request): Promise<Response> {
		const response = await this.#respond(request);
		for (const [name, value] of Object.entries(SECURITY_HEADERS))
			response.headers.set(name, value);
		return response;
	}

	async #respond(request: Request): Promise<Response> {
		// pi-lens-ignore: unchecked-throwing-call -- the server builds request.url, always an absolute URL
		const path = new URL(request.url).pathname;
		if (path !== this.#options.mount && !path.startsWith(this.#base))
			return new Response("Not found", { status: 404 });
		const rest = path.slice(this.#base.length);
		const open = await this.#options.authenticator.open?.(request, rest);
		if (open) return open;
		const admission = await this.#options.authenticator.authenticate(request);
		if ("refusal" in admission) return this.#refused(request, rest, admission);
		if (path === this.#options.mount)
			return new Response(null, {
				status: 302,
				headers: { location: this.#base },
			});
		if (rest === "api/events" && request.method === "GET")
			return this.#events();
		if (rest.startsWith("api/"))
			return this.#options.api.handle(
				request,
				rest.slice("api/".length),
				admission.visitor,
			);
		if (!READ_METHODS.has(request.method))
			return new Response("Method not allowed", { status: 405 });
		const asset = this.#options.assets.get(rest);
		if (asset && rest !== "index.html")
			return new Response(new Uint8Array(asset.body), {
				headers: {
					"content-type": asset.type,
					"cache-control": "private, max-age=31536000, immutable",
				},
			});
		if (rest === "" || rest === "index.html" || this.#options.pathRouting) {
			const page = this.#options.assets.get("index.html");
			if (page)
				return new Response(
					presentPage(
						page.body,
						this.#options.pathRouting ? this.#options.mount : undefined,
						this.#options.presentation,
					),
					{
						headers: {
							...PAGE_HEADERS,
							...(this.#options.pathRouting
								? {
										"content-security-policy": PAGE_HEADERS[
											"content-security-policy"
										].replace("base-uri 'none'", "base-uri 'self'"),
									}
								: {}),
						},
					},
				);
		}
		return new Response("Not found", { status: 404 });
	}

	/**
	 * The answer to a request the authenticator refused: a page navigation that signing in would
	 * fix goes to the login page, everything else gets the status and a fixed body.
	 */
	#refused(request: Request, rest: string, refusal: Unauthenticated): Response {
		if (
			refusal.login &&
			READ_METHODS.has(request.method) &&
			!rest.startsWith("api/")
		)
			return new Response(null, {
				status: 303,
				headers: {
					location: `${this.#options.mount}/login`,
					"cache-control": "no-store",
				},
			});
		// A missing session is the normal way to meet a login page, not worth a line each time.
		const { logger } = this.#options;
		const fields = { refusal: refusal.refusal };
		if (refusal.login) logger.debug(fields, "console request refused");
		else logger.warn(fields, "console request refused");
		return new Response(refusal.status === 401 ? "Unauthorized" : "Forbidden", {
			status: refusal.status,
			headers: { "cache-control": "no-store" },
		});
	}

	/** A server-sent event stream that says `changed` whenever the console may differ. */
	#events(): Response {
		if (this.#streams.size >= MAX_STREAMS)
			return new Response("Too many event streams", { status: 503 });
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>(
			{
				start: (c) => {
					controller = c;
					this.#streams.add(c);
					c.enqueue(encoder.encode("retry: 3000\n\n"));
				},
				cancel: () => {
					if (controller) this.#streams.delete(controller);
				},
			},
			new CountQueuingStrategy({ highWaterMark: STREAM_BACKLOG }),
		);
		return new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			},
		});
	}

	#changed(): void {
		if (this.#pending || this.#streams.size === 0) return;
		this.#pending = setTimeout(() => {
			this.#pending = undefined;
			this.#send("event: changed\ndata: {}\n\n");
		}, this.#options.coalesceMs ?? COALESCE_MS);
	}

	#send(text: string): void {
		const chunk = encoder.encode(text);
		for (const stream of this.#streams) {
			try {
				// An event only says "refetch", so a client that has not read its backlog is not worth
				// buffering for: it is closed, and its page reconnects after the retry delay.
				if ((stream.desiredSize ?? 0) <= 0) {
					this.#streams.delete(stream);
					stream.close();
				} else stream.enqueue(chunk);
			} catch {
				// The page went away; its stream is closed.
				this.#streams.delete(stream);
			}
		}
	}
}
