import { type ComponentType, type LazyExoticComponent, lazy } from "react";
import { hostUi } from "./frame-taps.ts";

/** What a page of the registry is given: the second part of its route, such as a host page's id. */
export interface PageRouteProps {
	/** The first part of the route: the page asked for. */
	pane: string;
	routeKey: string | undefined;
}

/**
 * The pages that are not panes of the config or rooms: the profile, and what the host rooms, pages
 * and notices add. A route whose first part is a key here shows that page. Pages load when first
 * opened, so they cost the first load nothing.
 */
// The pages of a person's own account share one entry, which picks its page by the route.
const account = lazy(() => import("../pages/account.tsx"));
export const PAGE_ROUTES: Record<
	string,
	LazyExoticComponent<ComponentType<PageRouteProps>>
> = {
	profile: account,
	notices: account,
	onboarding: account,
	// Every knight's temp-knight presets.
	presets: lazy(() => import("../pages/presets.tsx")),
	// Every knight's incoming webhooks.
	webhooks: lazy(() => import("../pages/webhooks.tsx")),
	// The chat home's page for the rooms that are hidden and the archive.
	hidden: lazy(() => import("../pages/hidden.tsx")),
	// The host's own pages, `p/<id>`.
	p: lazy(() => hostUi().then((ui) => ({ default: ui.HostPage }))),
};

/**
 * The routes a person who owes a required step may still open: their profile and settings, and the
 * pages where a step is finished. Everything else shows the gate.
 */
export const GATE_ROUTES: ReadonlySet<string> = new Set([
	"profile",
	"onboarding",
	"settings",
	"notices",
]);

/** The routes only the chat home has: its arranged list and its hidden page. */
const CHAT_ROUTES: ReadonlySet<string> = new Set(["arrange", "hidden"]);

/** Whether `name` is a route this host opens; the chat home's own routes exist only on that home. */
export function knownPane(
	name: string,
	panes: readonly string[],
	hasApp: boolean,
	chats: boolean,
): boolean {
	if (CHAT_ROUTES.has(name)) return hasApp && chats;
	return (
		panes.includes(name) ||
		(hasApp &&
			["room", "agent", "settings", "prompts", "more"].includes(name)) ||
		name === "more" ||
		(hasApp && name !== "profile" && name in PAGE_ROUTES)
	);
}
