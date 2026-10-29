import { mountOf } from "./router.ts";

/** The query of the address the page shows: the URL's own, or the one after a hash route's path. */
export function currentQuery(): URLSearchParams {
	if (mountOf() !== undefined)
		return new URLSearchParams(window.location.search);
	const hash = window.location.hash;
	const at = hash.indexOf("?");
	return new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
}

/**
 * Goes to an address under the page's origin, in place: the page keeps its state and its socket.
 * A tap on a notification while the app is open lands here. Returns false for an address that is
 * not the app's, which the caller then opens as a page load.
 */
export function followUrl(url: URL): boolean {
	if (url.origin !== window.location.origin) return false;
	const mount = mountOf();
	if (mount) {
		if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`))
			return false;
		window.history.pushState(null, "", url);
		window.dispatchEvent(new PopStateEvent("popstate"));
		return true;
	}
	if (url.pathname !== window.location.pathname) return false;
	window.location.hash = url.hash;
	return true;
}
