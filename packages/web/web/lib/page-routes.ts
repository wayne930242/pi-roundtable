import { type ComponentType, type LazyExoticComponent, lazy } from "react";

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
> = { profile: account, notices: account, onboarding: account };

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
