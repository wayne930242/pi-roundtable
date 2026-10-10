/** The longest origin kept; a longer header is not a browser's. */
const MAX_ORIGIN_LENGTH = 256;

/** A serialized origin: a scheme, `://`, and a host with an optional port, with no path, query or space. */
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+$/;

/**
 * The connection's `Origin` header as a tool may label a record with it: trimmed and lower-cased,
 * or undefined when the header is absent, the opaque `null`, over-long, or not a serialized origin.
 * Browsers always send one; a client that is not a browser sends any text it likes, so the shape
 * is checked here and nothing else is trusted about it.
 */
export function normalizeOrigin(header: string | null): string | undefined {
	const value = header?.trim().toLowerCase();
	if (!value || value.length > MAX_ORIGIN_LENGTH) return undefined;
	return ORIGIN.test(value) ? value : undefined;
}
