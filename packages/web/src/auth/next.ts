/**
 * Where a sign-in goes back to. A page link (from the host's own dashboard, a notification, or a
 * page the server turned away) names it as `?next=`, and only these shapes are taken: anything
 * else is dropped, so the callback never redirects to a place a link chose.
 *
 * - `profile`, `notices`, `settings`: a page of the app;
 * - `room:<key>`: a room of this app's surface (`<surface>:<kind>.<id>`);
 * - `p:<id>`: a host page, `[a-z0-9-]{1,40}`.
 */
export function allowedNext(
	value: string | null | undefined,
	surface: string,
): string | undefined {
	if (!value) return undefined;
	if (value === "profile" || value === "notices" || value === "settings")
		return value;
	const room = /^room:(.+)$/.exec(value)?.[1];
	if (room !== undefined)
		return new RegExp(`^${surface}:[A-Za-z0-9._~-]{1,160}$`).test(room)
			? value
			: undefined;
	const page = /^p:(.+)$/.exec(value)?.[1];
	return page !== undefined && /^[a-z0-9-]{1,40}$/.test(page)
		? value
		: undefined;
}

/** The app route a `next` names, as the page's router writes it: `room/<key>`, `p/<id>` or the page's name. */
export function routeOfNext(next: string): string {
	if (next.startsWith("room:"))
		return `room/${encodeURIComponent(next.slice("room:".length))}`;
	if (next.startsWith("p:")) return `p/${next.slice("p:".length)}`;
	return next;
}

/**
 * The `next` a page path stands for, for a server that turns away a page navigation (path
 * routing only: a hash route never reaches the server). Undefined for a path that names none.
 */
export function nextOfPath(rest: string, surface: string): string | undefined {
	const [first, second, ...more] = rest.split("/").filter(Boolean);
	if (more.length > 0 || first === undefined) return undefined;
	try {
		if (second === undefined) return allowedNext(first, surface);
		const key = decodeURIComponent(second);
		if (first === "room") return allowedNext(`room:${key}`, surface);
		if (first === "p") return allowedNext(`p:${key}`, surface);
	} catch {
		return undefined;
	}
	return undefined;
}
