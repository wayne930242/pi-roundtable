import { createHash } from "node:crypto";
import { DiagramRefusal, DiagramRenderer } from "./diagram-renderer.ts";

/** The most a diagram's source may be: 8 KB, so a request cannot make the host draw something huge. */
export const MAX_DIAGRAM_BYTES = 8 * 1024;
/** How many drawn diagrams are kept. */
const KEPT = 200;
/** How long a source that overran its time stays refused before it is tried again: on a loaded host an overrun is no verdict on the source. */
const OVERRUN_KEPT_MS = 10 * 60_000;
const SCHEMES = new Set(["light", "dark"]);

/** What an image answer says about itself: it cannot run script, and it never changes for the same URL. */
const IMAGE_HEADERS = {
	"content-type": "image/svg+xml",
	"cache-control": "private, max-age=31536000, immutable",
	"x-content-type-options": "nosniff",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
};

const refuse = (status: number, error: string, cache = "no-store"): Response =>
	Response.json({ error }, { status, headers: { "cache-control": cache } });

export interface DiagramServiceOptions {
	/** Draws the source; throws or rejects for one it cannot draw. Default: a worker thread drawing with `mermaidSvg`. */
	render?: (
		source: string,
		scheme: "light" | "dark",
	) => string | Promise<string>;
	/** How many renders, and refused sources, to keep; default 200. */
	capacity?: number;
	/** The longest one drawing may take, in milliseconds; default 3000. Not with `render`. */
	timeoutMs?: number;
	/** How many drawings may wait behind the one running; default 4. Not with `render`. */
	queue?: number;
}

/** How a source stands: drawn (the SVG), or one the app will not draw. */
type Verdict = string | null;

/**
 * `GET api/diagram?scheme=light|dark&s=<base64url source>`: a Mermaid diagram as an SVG image
 * for the page's `pbs-diagram`. The page shows it only as an `<img>`, which runs no script. The
 * drawing runs off the event loop, one at a time, with a time limit (see `DiagramRenderer`); the
 * verdicts are kept by a hash of scheme and source, the least recently used going first, and a source
 * that could not be drawn is remembered as well (one that overran its time, for ten minutes), so a
 * repeat costs nothing. A request that arrives
 * while its source is being drawn waits for that drawing.
 */
export class DiagramService {
	readonly #render: NonNullable<DiagramServiceOptions["render"]>;
	readonly #capacity: number;
	/** Insertion order is use order: a hit moves its entry to the end. */
	readonly #verdicts = new Map<string, Verdict>();
	/** When each source that overran may be tried again. */
	readonly #overran = new Map<string, number>();
	readonly #drawing = new Map<string, Promise<Verdict | "busy">>();

	constructor(options: DiagramServiceOptions = {}) {
		this.#render = options.render ?? workerRender(options);
		this.#capacity = options.capacity ?? KEPT;
	}

	async serve(request: Request): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const scheme = params.get("scheme") ?? "";
		const encoded = params.get("s") ?? "";
		if (
			!SCHEMES.has(scheme) ||
			encoded === "" ||
			/[^A-Za-z0-9_-]/.test(encoded)
		)
			return refuse(400, "A diagram needs a scheme and a source.");
		// Four characters of base64url are at most three bytes; refuse before decoding.
		if (encoded.length > Math.ceil((MAX_DIAGRAM_BYTES * 4) / 3) + 4)
			return refuse(413, "This diagram is too large to draw.");
		const source = Buffer.from(encoded, "base64url").toString("utf8");
		if (Buffer.byteLength(source) > MAX_DIAGRAM_BYTES)
			return refuse(413, "This diagram is too large to draw.");
		const key = createHash("sha256")
			.update(`${scheme}\0${source}`)
			.digest("hex");
		const verdict = await this.#verdictOf(
			key,
			source,
			scheme as "light" | "dark",
		);
		if (verdict === "busy")
			return refuse(503, "Diagrams are being drawn; try again shortly.");
		if (verdict === null)
			return refuse(422, "This is not a diagram the app can draw.");
		return new Response(verdict, { headers: IMAGE_HEADERS });
	}

	#verdictOf(
		key: string,
		source: string,
		scheme: "light" | "dark",
	): Promise<Verdict | "busy"> | Verdict {
		const kept = this.#verdicts.get(key);
		if (kept === null && (this.#overran.get(key) ?? Infinity) <= Date.now()) {
			this.#verdicts.delete(key);
			this.#overran.delete(key);
		} else if (kept !== undefined) {
			this.#verdicts.delete(key);
			this.#verdicts.set(key, kept);
			return kept;
		}
		const running = this.#drawing.get(key);
		if (running) return running;
		const drawing = this.#draw(source, scheme).then((verdict) => {
			this.#drawing.delete(key);
			if (verdict === "busy") return verdict;
			if (verdict === "slow") {
				this.#keep(key, null);
				this.#overran.set(key, Date.now() + OVERRUN_KEPT_MS);
				return null;
			}
			this.#keep(key, verdict);
			return verdict;
		});
		this.#drawing.set(key, drawing);
		return drawing;
	}

	async #draw(
		source: string,
		scheme: "light" | "dark",
	): Promise<Verdict | "busy" | "slow"> {
		try {
			return await this.#render(source, scheme);
		} catch (error) {
			if (error instanceof DiagramRefusal && error.why !== "invalid")
				return error.why;
			return null;
		}
	}

	#keep(key: string, verdict: Verdict): void {
		this.#verdicts.set(key, verdict);
		if (this.#verdicts.size > this.#capacity)
			for (const oldest of this.#verdicts.keys()) {
				this.#verdicts.delete(oldest);
				this.#overran.delete(oldest);
				break;
			}
	}
}

/** Drawing in a worker thread, one at a time. */
function workerRender(
	options: DiagramServiceOptions,
): NonNullable<DiagramServiceOptions["render"]> {
	const renderer = new DiagramRenderer({
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
		...(options.queue === undefined ? {} : { queue: options.queue }),
	});
	return (source, scheme) => renderer.draw(source, scheme);
}
