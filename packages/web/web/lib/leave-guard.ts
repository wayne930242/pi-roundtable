import { type RefObject, useCallback, useEffect, useState } from "react";
import { blockNavigation } from "./router.ts";

/** What the person is trying to leave with unsaved changes: by a link, or by code or the browser's back. */
export type Leaving =
	| { kind: "link"; anchor: HTMLAnchorElement }
	| { kind: "navigate"; proceed(): void };

/**
 * Holds the page where it is while `dirty`: closing or reloading asks the browser's own question,
 * and a link or a step back is caught and reported as `leaving`, for the page to ask about.
 * Links inside `inside` are the page's own and pass. `leave` lets the held step through, after
 * `discard` has made the page clean again.
 */
export function useLeaveGuard(
	dirty: boolean,
	inside: RefObject<HTMLElement | null>,
	discard: () => void,
): { leaving: Leaving | undefined; stay(): void; leave(): void } {
	const [leaving, setLeaving] = useState<Leaving>();
	useEffect(() => {
		if (!dirty) return;
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
			if (inside.current?.contains(anchor)) return;
			event.preventDefault();
			event.stopPropagation();
			setLeaving({ kind: "link", anchor });
		};
		const release = blockNavigation((proceed) =>
			setLeaving({ kind: "navigate", proceed }),
		);
		window.addEventListener("beforeunload", beforeUnload);
		document.addEventListener("click", onClick, true);
		return () => {
			release();
			window.removeEventListener("beforeunload", beforeUnload);
			document.removeEventListener("click", onClick, true);
		};
	}, [dirty, inside]);
	const stay = useCallback(() => setLeaving(undefined), []);
	const leave = useCallback(() => {
		const target = leaving;
		discard();
		setLeaving(undefined);
		if (target?.kind === "link") setTimeout(() => target.anchor.click(), 0);
		else if (target?.kind === "navigate") target.proceed();
	}, [leaving, discard]);
	return { leaving, stay, leave };
}
