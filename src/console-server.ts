import type { HttpRoute, Logger } from "pi-roundtable";
import type { AssetBundle } from "./assets.ts";
import type { ConsoleApi } from "./console-api.ts";
import type { RequestVerifier } from "./verifier.ts";

const encoder = new TextEncoder();
/** Changes closer together than this reach the page as one event. */
const COALESCE_MS = 250;
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
	verifier: RequestVerifier;
	/** The console's own origin; requests that change data must come from it. */
	origin: string;
	api: Pick<ConsoleApi, "handle">;
	/** Registers the listener with every source whose change the console shows. */
	subscribe(listener: () => void): void;
	logger: Logger;
}

/**
 * The console on the host's listener: `<mount>` redirects to `<mount>/`, and everything under
 * it needs the verifier to vouch for the owner. A request that changes data must also carry the
 * console's own `Origin`.
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
		if (path === this.#options.mount)
			return new Response(null, {
				status: 302,
				headers: { location: this.#base },
			});
		if (!path.startsWith(this.#base))
			return new Response("Not found", { status: 404 });
		const refusal = await this.#refusal(request);
		if (refusal !== undefined) {
			this.#options.logger.warn({ refusal }, "console request refused");
			return new Response("Forbidden", {
				status: 403,
				headers: { "cache-control": "no-store" },
			});
		}
		const rest = path.slice(this.#base.length);
		if (rest === "api/events" && request.method === "GET")
			return this.#events();
		if (rest.startsWith("api/"))
			return this.#options.api.handle(request, rest.slice("api/".length));
		if (!READ_METHODS.has(request.method))
			return new Response("Method not allowed", { status: 405 });
		if (rest === "" || rest === "index.html") {
			const page = this.#options.assets.get("index.html");
			if (page) return new Response(page.body, { headers: PAGE_HEADERS });
		}
		const asset = this.#options.assets.get(rest);
		if (asset && rest !== "index.html")
			return new Response(asset.body, {
				headers: {
					"content-type": asset.type,
					"cache-control": "private, max-age=31536000, immutable",
				},
			});
		return new Response("Not found", { status: 404 });
	}

	/** Undefined when the request may pass, otherwise why not; never throws. */
	async #refusal(request: Request): Promise<string | undefined> {
		try {
			const verdict = await this.#options.verifier(request);
			if (!verdict.admitted) return String(verdict.reason);
		} catch {
			// A verifier that fails admits no one.
			return "verifier failed";
		}
		if (
			!READ_METHODS.has(request.method) &&
			request.headers.get("origin") !== this.#options.origin
		)
			return "foreign origin";
		return undefined;
	}

	/** A server-sent event stream that says `changed` whenever the console may differ. */
	#events(): Response {
		if (this.#streams.size >= MAX_STREAMS)
			return new Response("Too many event streams", { status: 503 });
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start: (c) => {
				controller = c;
				this.#streams.add(c);
				c.enqueue(encoder.encode("retry: 3000\n\n"));
			},
			cancel: () => {
				if (controller) this.#streams.delete(controller);
			},
		});
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
		}, COALESCE_MS);
	}

	#send(text: string): void {
		const chunk = encoder.encode(text);
		for (const stream of this.#streams) {
			try {
				stream.enqueue(chunk);
			} catch {
				// The page went away; its stream is closed.
				this.#streams.delete(stream);
			}
		}
	}
}
