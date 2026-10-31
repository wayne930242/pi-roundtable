// Which rooms a folded group still shows, as a Discord category does: the room that is open, and any
// room with a card waiting for an answer or messages unread. The rest fold away under the heading.

import { useMemo } from "react";
import { useSelector } from "./app-store.ts";
import { useHost } from "./host-state.ts";
import { waitingCards } from "./rooms.ts";

/** The group's rooms that stay showing while it is folded, in the group's order. */
export function useStaying(
	keys: readonly string[],
	active: string | undefined,
): string[] {
	const joined = keys.join(",");
	const waiting = useSelector(
		(state) => keys.filter((key) => waitingCards(state, key) > 0).join(","),
		joined,
	);
	const unread = useHost((state) => state.unread);
	return useMemo(() => {
		const cards = new Set(waiting.split(","));
		return (joined ? joined.split(",") : []).filter(
			(key) => key === active || cards.has(key) || (unread[key] ?? 0) > 0,
		);
	}, [joined, waiting, unread, active]);
}
