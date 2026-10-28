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
	if (reducedMotion() || typeof document.startViewTransition !== "function") {
		update();
		return;
	}
	const running = document.startViewTransition(() => flushSync(update));
	// A transition that a newer one skips rejects these; nothing waits on them.
	running.ready.catch(() => undefined);
	running.updateCallbackDone.catch(() => undefined);
	running.finished.catch(() => undefined);
}
