import { useEffect, useRef, useState } from "react";
import { transition } from "./motion.ts";

/** The page's route: a pane, and for conversations optionally one conversation's key. */
export interface Route {
	pane: string;
	key?: string;
}

let mountPath: string | undefined;
/** The pane the root path shows. */
let homePane = "";
export function setRouting(mount: string | undefined, home = ""): void {
	mountPath = mount;
	homePane = home;
}
function current(): Route {
	try {
		const path = mountPath
			? window.location.pathname.slice(mountPath.length).replace(/^\//, "")
			: window.location.hash.replace(/^#\/?/, "");
		const [pane = "", key] = path.split("/").map(decodeURIComponent);
		return { pane, ...(key ? { key } : {}) };
	} catch {
		return { pane: "" };
	}
}

/** The route the address names now, for code outside a component. */
export const currentRoute = (): Route => current();

/** An asset the server ships under the mount (the install icons); relative when the page is not mounted. */
export const assetHref = (path: string): string =>
	`${mountPath ? `${mountPath}/` : "./"}${path}`;

export const hrefFor = (pane: string, key?: string): string =>
	`${mountPath ? `${mountPath}/` : "#/"}${pane === homePane && mountPath && !key ? "" : pane}${key ? `/${encodeURIComponent(key)}` : ""}`;

/** Asked before the page is left; `proceed` carries on with the navigation, dropping the block. */
export type NavigationBlocker = (proceed: () => void) => void;

let blocker: NavigationBlocker | undefined;
let releaseGuard: (() => void) | undefined;

/**
 * Holds navigation back until the blocker lets it through: `navigate()` asks it first, and
 * the browser's back (or a swipe) is caught by a sentinel history entry pushed while the block
 * stands. Returns the release; call it once there is nothing to protect any more.
 */
export function blockNavigation(ask: NavigationBlocker): () => void {
	blocker = ask;
	const href = window.location.href;
	window.history.pushState({ rtGuard: true }, "", href);
	const onPop = (event: PopStateEvent) => {
		// Landing on a sentinel (forward) is not leaving; only a step out of it is.
		if ((event.state as { rtGuard?: boolean } | null)?.rtGuard) return;
		event.stopImmediatePropagation();
		// Stand back on the sentinel so the page stays where it is until the person decides.
		window.history.pushState({ rtGuard: true }, "", href);
		ask(() => {
			release();
			// The sentinel and the page's own entry are both behind the destination.
			window.history.go(-2);
		});
	};
	window.addEventListener("popstate", onPop, true);
	const release = () => {
		if (blocker !== ask) return;
		blocker = undefined;
		releaseGuard = undefined;
		window.removeEventListener("popstate", onPop, true);
		// The sentinel stays in the history as a copy of the page; it is no longer a guard.
		if ((window.history.state as { rtGuard?: boolean } | null)?.rtGuard)
			window.history.replaceState(null, "", window.location.href);
	};
	releaseGuard = release;
	return release;
}

/** Goes to a pane (and key) as the browser's own navigation would, with a view transition. */
export function navigate(
	pane: string,
	key?: string,
	options: { replace?: boolean } = {},
): void {
	const href = hrefFor(pane, key);
	const replace = options.replace === true;
	if (blocker) {
		blocker(() => {
			releaseGuard?.();
			go(href, replace);
		});
		return;
	}
	go(href, replace);
}

function go(href: string, replace: boolean): void {
	// A step that only stands in for another leaves no history entry behind it, so Back does not return to it.
	if (replace) {
		window.history.replaceState(null, "", href);
		window.dispatchEvent(new PopStateEvent("popstate"));
		return;
	}
	if (mountPath) {
		window.history.pushState(null, "", href);
		window.dispatchEvent(new PopStateEvent("popstate"));
	} else window.location.hash = href.slice(1);
}

export function useRoute(): Route {
	const [route, setRoute] = useState<Route>(current);
	const shown = useRef(route);
	shown.current = route;
	useEffect(() => {
		const onChange = () => {
			const next = current();
			// A history step that lands on the page already shown (the room switcher's own entry) moves nothing.
			if (next.pane === shown.current.pane && next.key === shown.current.key)
				return;
			transition(() => setRoute(next));
			window.scrollTo(0, 0);
		};
		window.addEventListener("hashchange", onChange);
		window.addEventListener("popstate", onChange);
		const click = (event: MouseEvent) => {
			if (
				!mountPath ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey ||
				event.defaultPrevented
			)
				return;
			const anchor =
				event.target instanceof Element ? event.target.closest("a") : null;
			if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
			const url = new URL(anchor.href);
			if (
				url.origin !== window.location.origin ||
				!url.pathname.startsWith(`${mountPath}/`)
			)
				return;
			event.preventDefault();
			window.history.pushState(null, "", url);
			onChange();
		};
		document.addEventListener("click", click);
		return () => {
			window.removeEventListener("hashchange", onChange);
			window.removeEventListener("popstate", onChange);
			document.removeEventListener("click", click);
		};
	}, []);
	return route;
}
