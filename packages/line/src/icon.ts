import type { HttpRoute } from "pi-roundtable";

/** Serves one fixed PNG, so the host can give LINE a stable `iconUrl` for a sender without another service. */
export interface SenderIconRoute {
	/** Where it is served, such as `/line/sender-icon.png`. */
	path: string;
	/** The PNG's bytes. */
	png: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** What LINE accepts of a sender icon. */
const ICON_MAX_BYTES = 1024 * 1024;

/** Refuses an icon that is not a PNG LINE could show. */
export function checkIcon(png: Uint8Array): void {
	if (!(png instanceof Uint8Array) || png.length === 0)
		throw new Error("line: senderIconRoute.png must hold the bytes of a PNG");
	if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte))
		throw new Error("line: senderIconRoute.png is not a PNG file");
	if (png.length > ICON_MAX_BYTES)
		throw new Error(
			`line: senderIconRoute.png must be at most ${ICON_MAX_BYTES} bytes`,
		);
}

/** The route that serves the icon, to `GET` and `HEAD`, with a cache header for a year. */
export function iconRoute(
	options: SenderIconRoute,
	listener: string,
): HttpRoute {
	const bytes = new Uint8Array(options.png);
	const headers = {
		"content-type": "image/png",
		"content-length": String(bytes.length),
		"cache-control": "public, max-age=31536000, immutable",
	};
	return {
		name: "line-sender-icon",
		listener,
		path: { exact: options.path },
		methods: ["GET", "HEAD"],
		handle: (request) =>
			new Response(request.method === "HEAD" ? null : bytes, { headers }),
	};
}
