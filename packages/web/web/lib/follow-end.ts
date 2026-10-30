import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** How far from the end still counts as being at it, in pixels. */
const NEAR = 24;

/**
 * Keeps a scroller that is growing on its newest end while `active`, until the person scrolls away
 * from the end: the box a reply streams into is bounded, so past its height the newest words would
 * otherwise be out of sight. `change` is whatever makes it grow. Once `active` ends, the scroller is
 * left where it is, and the next time it is active it follows again.
 */
export function useFollowEnd(
	scroller: RefObject<HTMLElement | null>,
	active: boolean,
	change: unknown,
): void {
	const following = useRef(true);
	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const onScroll = () => {
			following.current =
				element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR;
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => element.removeEventListener("scroll", onScroll);
	}, [scroller]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `change` is what the scroll follows
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!active) {
			following.current = true;
			return;
		}
		if (element && following.current) element.scrollTop = element.scrollHeight;
	}, [scroller, active, change]);
}
