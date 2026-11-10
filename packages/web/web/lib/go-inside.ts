// A tap on a link to a room inside the room drawer goes there as a tap on its row does: the drawer
// closes first, then the room opens.

import type { MouseEvent } from "react";

/** The links the drawer's lists draw: a thread card or temp knight, a chat row, a pin. */
const LINK = "a[data-link-room], a.room-row[data-room], a[data-room-pin]";

/**
 * Takes the click on a link to a room and hands its key to `go`. A swipe or hold that already took
 * the click has prevented it; a click with a modifier is left to the browser.
 */
export function goInside(event: MouseEvent, go: (key: string) => void): void {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey ||
		!(event.target instanceof Element)
	)
		return;
	const link = event.target.closest<HTMLElement>(LINK);
	const key =
		link?.dataset.linkRoom ?? link?.dataset.room ?? link?.dataset.roomPin;
	if (!key) return;
	event.preventDefault();
	go(key);
}
