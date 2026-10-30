import { flushSync } from "react-dom";

/** Whether the person asked for less motion; animation then jumps to its end. */
export const reducedMotion = (): boolean =>
	typeof matchMedia === "function" &&
	matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs a change of what the page shows as a view transition where the browser has them and the
 * person allows motion; elsewhere it just runs. `update` must change the DOM synchronously.
 */
export function transition(update: () => void): void {
	// A dive into a seat (lib/seat-dive.ts) is its own transition, and a snapshot cross-fade would paint over it.
	if (
		reducedMotion() ||
		typeof document.startViewTransition !== "function" ||
		document.documentElement.hasAttribute("data-dive")
	) {
		update();
		return;
	}
	const running = document.startViewTransition(() => flushSync(update));
	// A transition that a newer one skips rejects these; nothing waits on them.
	running.ready.catch(() => undefined);
	running.updateCallbackDone.catch(() => undefined);
	running.finished.catch(() => undefined);
}
