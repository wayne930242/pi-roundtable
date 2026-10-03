import { useEffect, useState } from "react";

/** The page's route: a pane, and for conversations optionally one conversation's key. */
export interface Route {
	pane: string;
	key?: string;
}

let mountPath: string | undefined;
export function setRouting(mount: string | undefined): void {
	mountPath = mount;
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

export const hrefFor = (pane: string, key?: string): string =>
	`${mountPath ? `${mountPath}/` : "#/"}${pane === "overview" && mountPath ? "" : pane}${key ? `/${encodeURIComponent(key)}` : ""}`;

export function useRoute(): Route {
	const [route, setRoute] = useState<Route>(current);
	useEffect(() => {
		const onChange = () => {
			setRoute(current());
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
