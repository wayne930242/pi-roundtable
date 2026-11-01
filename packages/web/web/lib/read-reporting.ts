import { type RefObject, useEffect, useRef } from "react";
import { useSelector } from "./app-store.ts";
import { type AppConnection, useConnection } from "./socket.ts";

/**
 * Sends a room's read cursor: never back, at most once a second, the furthest offer winning while
 * one waits. The server keeps a cursor that never moves back, so a repeat changes nothing there.
 */
function readSender(connection: AppConnection, room: string) {
	let sent = 0;
	let last = 0;
	let wanted = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		timer = undefined;
		if (wanted <= sent) return;
		const wait = last + 1000 - Date.now();
		if (wait > 0) {
			timer = setTimeout(flush, wait);
			return;
		}
		if (connection.send({ type: "read", room, upTo: wanted })) {
			sent = wanted;
			last = Date.now();
		}
	};
	return {
		offer(upTo: number) {
			wanted = Math.max(wanted, upTo);
			if (timer === undefined) flush();
		},
		stop() {
			clearTimeout(timer);
		},
	};
}

/**
 * Tells the server how far the person has read: the newest message whose box is in the scroller's
 * view while the page is visible.
 */
export function useReadReporting(
	room: string,
	scroller: RefObject<HTMLElement | null>,
): void {
	const connection = useConnection();
	const connects = useSelector((state) => state.connects);
	// `connects` is in the list because a new connection says the server may have lost the cursor.
	useEffect(() => {
		const root = scroller.current;
		if (!root) return;
		const sender = readSender(connection, room);
		let frame: number | undefined;
		const measure = () => {
			frame = undefined;
			if (document.visibilityState !== "visible") return;
			const box = root.getBoundingClientRect();
			let seen = 0;
			for (const item of root.querySelectorAll<HTMLElement>("[data-mid]")) {
				const at = item.getBoundingClientRect();
				if (at.bottom > box.top && at.top < box.bottom - 4)
					seen = Math.max(seen, Number(item.dataset.mid));
			}
			if (seen > 0) sender.offer(seen);
		};
		const schedule = () => {
			if (frame === undefined) frame = requestAnimationFrame(measure);
		};
		root.addEventListener("scroll", schedule, { passive: true });
		document.addEventListener("visibilitychange", schedule);
		window.addEventListener("resize", schedule);
		const watcher = new MutationObserver(schedule);
		watcher.observe(root, { childList: true, subtree: true });
		schedule();
		return () => {
			root.removeEventListener("scroll", schedule);
			document.removeEventListener("visibilitychange", schedule);
			window.removeEventListener("resize", schedule);
			watcher.disconnect();
			sender.stop();
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [connection, room, scroller, connects]);
}

/**
 * Tells the server how far the person has read where one message shows at a time, as in the
 * scene's dialogue box: up to `upTo`, the stored message on show, while `showing` and the page is
 * visible. A message seen while the page was hidden is reported when it shows again.
 */
export function useShownReadReporting(
	room: string,
	upTo: number | undefined,
	showing: boolean,
): void {
	const connection = useConnection();
	const connects = useSelector((state) => state.connects);
	const shown = useRef<number | undefined>(undefined);
	shown.current = showing ? upTo : undefined;
	const sender = useRef<ReturnType<typeof readSender>>(undefined);
	// `connects` is in the list because a new connection says the server may have lost the cursor.
	useEffect(() => {
		const own = readSender(connection, room);
		sender.current = own;
		const offer = () => {
			if (document.visibilityState === "visible" && shown.current !== undefined)
				own.offer(shown.current);
		};
		document.addEventListener("visibilitychange", offer);
		offer();
		return () => {
			document.removeEventListener("visibilitychange", offer);
			own.stop();
			if (sender.current === own) sender.current = undefined;
		};
	}, [connection, room, connects]);
	useEffect(() => {
		if (showing && upTo !== undefined && document.visibilityState === "visible")
			sender.current?.offer(upTo);
	}, [showing, upTo]);
}
