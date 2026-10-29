import type { OpenTarget } from "../web-app.ts";

/** How the page's routes are written in an address. */
export interface RoutingOptions {
	/** The path the console is served under, without a trailing slash. */
	mount: string;
	/** `path` puts the route in the path; `hash` after a `#`. */
	routing: "path" | "hash";
}

const queryOf = (
	query: Readonly<Record<string, string>> | undefined,
): string => {
	const entries = Object.entries(query ?? {});
	if (entries.length === 0) return "";
	return `?${new URLSearchParams(entries).toString()}`;
};

/**
 * The address a tap on a notice or push opens, under the origin: a room (scrolled to a message
 * when one is named), a page with its query, or the app itself when the target is absent. The
 * service worker, and a cold start of the app, open exactly this address.
 */
export function openUrl(
	open: OpenTarget | undefined,
	routing: RoutingOptions,
): string {
	const base =
		routing.routing === "path" ? `${routing.mount}/` : `${routing.mount}/#/`;
	if (!open) return `${routing.mount}/`;
	if ("room" in open)
		return `${base}room/${encodeURIComponent(open.room)}${queryOf(
			open.message === undefined
				? undefined
				: { message: String(open.message) },
		)}`;
	return `${base}p/${encodeURIComponent(open.page)}${queryOf(open.query)}`;
}
