import { type RefObject, useEffect } from "react";
import { blockNavigation } from "../lib/router.ts";

/** What the person is trying to leave with unsaved changes: the form itself, or by a link. */
export type Leaving =
	| { kind: "cancel" }
	| { kind: "link"; anchor: HTMLAnchorElement }
	| { kind: "navigate"; proceed(): void };

/**
 * Asks before unsaved changes are left: closing or reloading the page, a link inside the app, the
 * room switcher and the browser's back. `held` is false while there is nothing to lose, and the
 * form `root` is the one place a link may be followed without asking.
 */
export function useLeaveGuard(
	root: RefObject<HTMLFormElement | null>,
	held: boolean,
	onLeaving: (leaving: Leaving) => void,
): void {
	useEffect(() => {
		if (!held) return;
		const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
		const onClick = (event: MouseEvent) => {
			if (
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			const anchor =
				event.target instanceof Element ? event.target.closest("a") : null;
			if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
			if (root.current?.contains(anchor)) return;
			event.preventDefault();
			event.stopPropagation();
			onLeaving({ kind: "link", anchor });
		};
		// Navigation by code (the room switcher) and the browser's back or a swipe.
		const release = blockNavigation((proceed) =>
			onLeaving({ kind: "navigate", proceed }),
		);
		window.addEventListener("beforeunload", beforeUnload);
		document.addEventListener("click", onClick, true);
		return () => {
			release();
			window.removeEventListener("beforeunload", beforeUnload);
			document.removeEventListener("click", onClick, true);
		};
	}, [held, root, onLeaving]);
}
