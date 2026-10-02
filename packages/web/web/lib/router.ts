import { useEffect, useState } from "react";

/** The page's route: a pane, and for conversations optionally one conversation's key. */
export interface Route {
	pane: string;
	key?: string;
}

function current(): Route {
	const [pane = "", key] = window.location.hash
		.replace(/^#\/?/, "")
		.split("/")
		.map(decodeURIComponent);
	return { pane, ...(key ? { key } : {}) };
}

export const hrefFor = (pane: string, key?: string): string =>
	`#/${pane}${key ? `/${encodeURIComponent(key)}` : ""}`;

export function useRoute(): Route {
	const [route, setRoute] = useState<Route>(current);
	useEffect(() => {
		const onChange = () => {
			setRoute(current());
			window.scrollTo(0, 0);
		};
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return route;
}
