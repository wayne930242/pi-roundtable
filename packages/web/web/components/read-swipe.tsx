import { type RefObject, useEffect } from "react";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

/** What a room's row uncovers as it is swiped to the right; the menu's "Mark as read" is the way a reader is told of. */
export function ReadReveal() {
	return (
		<span className="read-reveal" aria-hidden="true">
			<Icon name="check" size={16} />
			{t("Read")}
		</span>
	);
}

/** Gives the room rows inside `root` the swipe that marks a room read; the gesture loads after the list. */
export function useReadSwipe(root: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		let gone = false;
		let detach: (() => void) | undefined;
		import("../lib/read-swipe.ts").then((m) => {
			if (!gone) detach = m.attachReadSwipe(element);
		});
		return () => {
			gone = true;
			detach?.();
		};
	}, [root]);
}
