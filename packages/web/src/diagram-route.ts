import { createHash } from "node:crypto";
import { mermaidSvg } from "pi-better-show/server";

/** The most a diagram's source may be: 8 KB, so a request cannot make the host draw something huge. */
export const MAX_DIAGRAM_BYTES = 8 * 1024;
/** How many drawn diagrams are kept. */
const KEPT = 200;
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
	/** Draws the source; throws for one it cannot draw. Default `mermaidSvg` with a transparent background. */
	render?: (source: string, scheme: "light" | "dark") => string;
	/** How many renders to keep; default 200. */
	capacity?: number;
}

/**
 * `GET api/diagram?scheme=light|dark&s=<base64url source>`: a Mermaid diagram as an SVG image
 * for the page's `pbs-diagram`. The page shows it only as an `<img>`, which runs no script. The
 * renders are kept by a hash of scheme and source, the least recently used going first.
 */
export class DiagramService {
	readonly #render: NonNullable<DiagramServiceOptions["render"]>;
	readonly #capacity: number;
	/** Insertion order is use order: a hit moves its entry to the end. */
	readonly #renders = new Map<string, string>();

	constructor(options: DiagramServiceOptions = {}) {
		this.#render =
			options.render ??
			((source, scheme) => mermaidSvg(source, { scheme, transparent: true }));
		this.#capacity = options.capacity ?? KEPT;
	}

	serve(request: Request): Response {
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
		let svg = this.#renders.get(key);
		if (svg === undefined) {
			try {
				svg = this.#render(source, scheme as "light" | "dark");
			} catch {
				return refuse(422, "This is not a diagram the app can draw.");
			}
		} else this.#renders.delete(key);
		this.#renders.set(key, svg);
		if (this.#renders.size > this.#capacity)
			for (const oldest of this.#renders.keys()) {
				this.#renders.delete(oldest);
				break;
			}
		return new Response(svg, { headers: IMAGE_HEADERS });
	}
}
