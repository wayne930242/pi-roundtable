import type { HttpRoute, Logger, WebSocketRoute } from "pi-roundtable";
import type { AppSocket } from "./app/sockets.ts";
import type { AssetBundle } from "./assets.ts";
import type {
	Authenticated,
	Authenticator,
	Unauthenticated,
} from "./auth/authenticator.ts";
import { allowedNext, nextOfPath } from "./auth/next.ts";
import { type Decision, decide } from "./authz.ts";
import type { ConsoleApi } from "./console-api.ts";
import { type ConsolePresentation, message } from "./features.ts";
import type { Gate } from "./gate.ts";
import { json } from "./http.ts";
import {
	defaultDescription,
	type PageMeta,
	presentPage,
} from "./page-presentation.ts";
import { hasMarkSvg, isPublicStatic, servePwa } from "./pwa.ts";
import type { Visitor } from "./visitors.ts";
import { viewerOf } from "./web-app.ts";

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
	/**
	 * The owner app, when the `rooms` pane is served: it answers its own paths below the mount
	 * before the console's API does, and its WebSocket takes the upgrades of the console's route.
	 */
	app?: {
		handle(
			request: Request,
			rest: string,
			admission: Authenticated,
		): Promise<Response | undefined>;
		websocket: WebSocketRoute<AppSocket>;
	};
	/** The onboarding gate; without it nobody is gated. */
	gate?: Pick<Gate, "required">;
	/** The app's surface, for the `next` a turned-away page navigation asks to come back to. */
	surface?: string;
	/** Registers the listener with every source whose change the console shows. */
	subscribe(listener: () => void): void;
	logger: Logger;
	/** How long changes are gathered into one event; default 250 ms. Tests set it lower. */
	coalesceMs?: number;
	/** Serve client page paths as the same authenticated document. */
	pathRouting?: boolean;
	presentation?: ConsolePresentation;
	/** The manifest's name; default `Roundtable`. */
	title?: string;
	/** Where the install icons come from; default the ones this package ships. */
	iconsDir?: string;
	look?: "modern" | "camelot";
	/** The console's own origin, for the absolute `og:image` of a link preview. */
	origin?: string;
	/** What the page says about itself in a search result and a link preview; default derived from the title. */
	description?: string;
}

/**
 * The console on the host's listener: `<mount>` redirects to `<mount>/`, and everything under
 * it needs the authenticator to admit the request, apart from what it answers openly, such as a
 * login page. An admitted request is then judged by the authorization table before any handler
 * sees it: a route that is not listed answers 404, one for owners answers a member 403, and while
 * the person owes a required step only the routes open to them answer. A request that changes
 * data must also carry the console's own `Origin`.
 */
export class ConsoleServer {
	readonly #options: ConsoleServerOptions;
	readonly #base: string;
	readonly #meta: PageMeta | undefined;
	readonly #streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	#pending: ReturnType<typeof setTimeout> | undefined;
	#ping: ReturnType<typeof setInterval> | undefined;

	constructor(options: ConsoleServerOptions) {
		this.#options = options;
		this.#base = `${options.mount}/`;
		const title = options.title ?? "Roundtable";
		this.#meta = options.origin
			? {
					title,
					description: options.description ?? defaultDescription(title),
					origin: options.origin,
					mount: options.mount,
					svg: hasMarkSvg(options.iconsDir),
				}
			: undefined;
		options.subscribe(() => this.#changed());
	}

	/**
	 * The routes on `listener`. `maxRequestBodyBytes` is the largest body the console takes, for
	 * the owner app's uploads; without it the listener's default stands.
	 */
	routes(listener: string, maxRequestBodyBytes?: number): HttpRoute[] {
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
				...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
				...(this.#options.app
					? { websocket: this.#options.app.websocket }
					: {}),
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
		// Static and the same for everyone: a sign-in page and a link preview show the icon without a session.
		if (READ_METHODS.has(request.method) && isPublicStatic(rest)) {
			const shown = servePwa(rest, this.#pwa());
			if (shown) return shown;
		}
		const open = await this.#options.authenticator.open?.(request, rest);
		if (open) return open;
		const admission = await this.#options.authenticator.authenticate(request);
		if ("refusal" in admission) return this.#refused(request, rest, admission);
		if (path === this.#options.mount)
			return new Response(null, {
				status: 302,
				headers: { location: this.#base },
			});
		const decision = decide(request.method, rest, {
			tier: admission.visitor.tier,
			gated: await this.#gated(admission.visitor),
		});
		if (!decision.allow) return this.#denied(decision);
		if (rest === "api/events" && request.method === "GET")
			return this.#events();
		const owned = await this.#options.app?.handle(request, rest, admission);
		if (owned) return owned;
		if (rest.startsWith("api/"))
			return this.#options.api.handle(
				request,
				rest.slice("api/".length),
				admission.visitor,
			);
		if (!READ_METHODS.has(request.method))
			return new Response("Method not allowed", { status: 405 });
		const installable = servePwa(rest, this.#pwa());
		if (installable) return installable;
		const asset = this.#options.assets.get(rest);
		if (asset && rest !== "index.html" && rest !== "sw.js")
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
						this.#options.look,
						this.#meta,
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

	#pwa(): Parameters<typeof servePwa>[1] {
		return { ...this.#options, title: this.#options.title ?? "Roundtable" };
	}

	async #gated(visitor: Visitor): Promise<boolean> {
		const { gate } = this.#options;
		if (!gate) return false;
		try {
			return (await gate.required(viewerOf(visitor))).length > 0;
		} catch (error) {
			// A gate that cannot be read stays shut.
			this.#options.logger.warn({ err: error }, "the gate was not read");
			return true;
		}
	}

	/** The answer to a request the authorization table refused. */
	#denied(decision: Extract<Decision, { allow: false }>): Response {
		const { presentation, logger } = this.#options;
		logger.debug({ reason: decision.reason }, "console request denied");
		if (decision.gate)
			return json(
				{
					error: message(presentation, "Finish setting up first."),
					gate: true,
				},
				403,
			);
		return json(
			{
				error: message(
					presentation,
					decision.status === 404
						? "There is no such API."
						: "Only an owner may do this.",
				),
			},
			decision.status,
		);
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
		) {
			// A link can name where to come back to (`?next=`), and so can a path route; a hash route's place never reaches the server.
			const surface = this.#options.surface ?? "app";
			const named = allowedNext(
				URL.parse(request.url)?.searchParams.get("next"),
				surface,
			);
			const next =
				named ??
				(this.#options.pathRouting ? nextOfPath(rest, surface) : undefined);
			return new Response(null, {
				status: 303,
				headers: {
					location: `${this.#options.mount}/login${next ? `?next=${encodeURIComponent(next)}` : ""}`,
					"cache-control": "no-store",
				},
			});
		}
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
