import { reducedMotion } from "./motion.ts";

/**
 * The dive into a seat: the view zooms toward the seat that was tapped, slowly at first and then all
 * at once, and the page it opens settles in from just beyond full size. It is two Web Animations on
 * `transform` and `opacity`, so the compositor does the work and a phone keeps its frame rate.
 *
 * The page's own view transitions cannot carry it: a cross-fade of two snapshots has no zoom toward
 * a point, and while one runs the live page underneath cannot be animated. So the dive holds its
 * last frame until the route has committed, the router skips its view transition for that one change
 * (`data-dive` on the root, which `transition()` reads), and the new page settles by itself.
 */

/** Where the view was tapped, in viewport pixels. */
export interface Point {
	x: number;
	y: number;
}

/** How long the zoom takes; the curve spends most of it creeping and the rest rushing in. */
export const DIVE_MS = 380;
export const DIVE_EASE = "cubic-bezier(0.7, 0, 0.84, 0)";
const DIVE_SCALE = 2.4;
/** What is left of the view at the end of the zoom, so the swap that follows is not a cut to blank. */
const DIVE_FADE = 0.35;
export const SETTLE_MS = 260;
const SETTLE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const SETTLE_SCALE = 1.06;
/** How long the last frame is held for a route that does not commit; then the view is given back. */
const HOLD_MS = 700;

interface Dive {
	host: Element;
	phase: "diving" | "committing";
	/** Gives the view back and drops the dive; only while it is still zooming. */
	abort(): void;
}

let running: Dive | undefined;

/** Whether a dive is under way; a tap during one is no second navigation. */
export const diving = (): boolean => running !== undefined;

/** Stops the dive of `host` before it navigates, if there is one: the view is given back as it was. */
export function cancelDive(host: Element): void {
	if (running?.host === host && running.phase === "diving") running.abort();
}

const settleIn = (page: Element | null): void => {
	if (!page || typeof page.animate !== "function") return;
	page.animate(
		[
			{ transform: `scale(${SETTLE_SCALE})`, opacity: DIVE_FADE },
			{ transform: "scale(1)", opacity: 1 },
		],
		{ duration: SETTLE_MS, easing: SETTLE_EASE },
	);
};

/**
 * Zooms the page toward `at`, then calls `go` once to open the seat. Without motion (the person asked
 * for less, or the browser cannot animate) `go` runs at once. A tap while a dive runs is dropped, and
 * so is a dive that Back, or the table leaving the page, interrupts: neither leaves the view scaled
 * or navigates twice. `warm` starts loading what `go` opens while the zoom runs, so the page is
 * there when the zoom ends and the view never shows a loading state in between.
 */
export function diveInto(
	host: HTMLElement,
	at: Point,
	go: () => void,
	warm?: () => void,
): void {
	if (running) return;
	// The zoom is of the whole route, so the title and the lists scale with the table; the host alone when it stands outside one.
	const view = host.closest<HTMLElement>("main.route") ?? host;
	if (reducedMotion() || typeof view.animate !== "function") {
		go();
		return;
	}
	warm?.();
	const box = view.getBoundingClientRect();
	const origin = `${at.x - box.left}px ${at.y - box.top}px`;
	const kept = {
		overflow: view.style.overflow,
		events: view.style.pointerEvents,
	};
	// What grows past the route is cut at its edge, and nothing under the zoom takes a tap.
	view.style.overflow = "hidden";
	view.style.pointerEvents = "none";
	const zoom = view.animate(
		[
			{ transformOrigin: origin, transform: "scale(1)", opacity: 1 },
			{
				transformOrigin: origin,
				transform: `scale(${DIVE_SCALE})`,
				opacity: DIVE_FADE,
			},
		],
		{ duration: DIVE_MS, easing: DIVE_EASE, fill: "forwards" },
	);
	const root = document.documentElement;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watch: MutationObserver | undefined;
	const restore = () => {
		view.style.overflow = kept.overflow;
		view.style.pointerEvents = kept.events;
		zoom.cancel();
	};
	const leave = () => {
		window.removeEventListener("popstate", abort);
		window.removeEventListener("hashchange", abort);
	};
	const dive: Dive = { host, phase: "diving", abort };
	function abort() {
		if (running !== dive || dive.phase !== "diving") return;
		leave();
		restore();
		running = undefined;
	}
	/** The route committed (or never will): the held frame goes, and a page that came settles in. */
	const finish = (committed: boolean) => {
		if (running !== dive) return;
		watch?.disconnect();
		clearTimeout(timer);
		root.removeAttribute("data-dive");
		restore();
		running = undefined;
		if (committed) settleIn(document.querySelector("main.route"));
	};
	running = dive;
	// Back, or any other step of the history, during the zoom ends it and navigates nowhere.
	window.addEventListener("popstate", abort);
	window.addEventListener("hashchange", abort);
	zoom.finished.then(
		() => {
			if (running !== dive || dive.phase !== "diving") return;
			dive.phase = "committing";
			leave();
			root.setAttribute("data-dive", "");
			go();
			if (!host.isConnected) {
				finish(true);
				return;
			}
			// The table leaving the page is the route committing.
			watch = new MutationObserver(() => {
				if (!host.isConnected) finish(true);
			});
			watch.observe(view.parentElement ?? document.body, {
				childList: true,
				subtree: true,
			});
			timer = setTimeout(() => finish(!host.isConnected), HOLD_MS);
		},
		// A cancelled animation rejects; whoever cancelled it has already given the view back.
		() => undefined,
	);
}
