import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { reducedMotion } from "./motion.ts";

/** How close to the end a scroll toward it must come to keep the end in view again, in pixels. */
const CATCH = 96;

/** How close to the end still counts as resting at it, in pixels. */
const AT_END = 2;

/** How far a scroller's view is from its end, in pixels. */
const distance = (element: HTMLElement) =>
	element.scrollHeight - element.scrollTop - element.clientHeight;

/** The keys that move a scroller toward its start. */
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Keeps the end of a scroller in view while the person is at the end, and says when more arrived
 * while they were not. The person leaves the end the moment they move toward the start (a wheel, a
 * finger, a key, or a scroll up the content did not cause), so content that settles or grows while
 * they read, such as rows laid out as they come near or a reply streaming in, never pulls them back
 * down. They come back by scrolling down near the end, or by `toEnd`. A scroll event caused by the
 * content changing height is not the person moving.
 */
export function useStickToEnd(scroller: RefObject<HTMLDivElement | null>) {
	const stuck = useRef(true);
	const height = useRef(0);
	const top = useRef(0);
	const [away, setAway] = useState(false);

	/** The person moved toward the start: stop following the end, whatever the distance. */
	const leave = useCallback(() => {
		const element = scroller.current;
		if (!element || !stuck.current) return;
		stuck.current = false;
		setAway(distance(element) > AT_END);
	}, [scroller]);

	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		let touchY: number | undefined;
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < 0) leave();
		};
		const onTouchStart = (event: TouchEvent) => {
			touchY = event.touches[0]?.clientY;
		};
		const onTouchMove = (event: TouchEvent) => {
			const y = event.touches[0]?.clientY;
			// A finger moving down drags the content toward its start.
			if (y !== undefined && touchY !== undefined && y > touchY) leave();
			touchY = y;
		};
		const onKey = (event: KeyboardEvent) => {
			if (UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey))
				leave();
		};
		element.addEventListener("wheel", onWheel, { passive: true });
		element.addEventListener("touchstart", onTouchStart, { passive: true });
		element.addEventListener("touchmove", onTouchMove, { passive: true });
		element.addEventListener("keydown", onKey);
		return () => {
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("touchstart", onTouchStart);
			element.removeEventListener("touchmove", onTouchMove);
			element.removeEventListener("keydown", onKey);
		};
	}, [scroller, leave]);

	const onScroll = useCallback(() => {
		const element = scroller.current;
		if (!element) return;
		const previous = top.current;
		top.current = element.scrollTop;
		if (element.scrollHeight !== height.current) {
			height.current = element.scrollHeight;
			return;
		}
		const left = distance(element);
		if (element.scrollTop < previous) stuck.current = left <= AT_END;
		else if (left < CATCH) stuck.current = true;
		setAway(!stuck.current && left > AT_END);
	}, [scroller]);

	/** The content changed size: follow it to the end, or note that there is more below. */
	const onGrow = useCallback(() => {
		const element = scroller.current;
		if (!element) return;
		height.current = element.scrollHeight;
		if (stuck.current) {
			element.scrollTo({ top: element.scrollHeight });
			top.current = element.scrollTop;
		} else if (distance(element) > AT_END) setAway(true);
	}, [scroller]);

	const toEnd = useCallback(
		(smooth: boolean) => {
			const element = scroller.current;
			if (!element) return;
			stuck.current = true;
			height.current = element.scrollHeight;
			element.scrollTo({
				top: element.scrollHeight,
				behavior: smooth && !reducedMotion() ? "smooth" : "auto",
			});
			setAway(false);
		},
		[scroller],
	);

	return { away, onScroll, onGrow, toEnd };
}
