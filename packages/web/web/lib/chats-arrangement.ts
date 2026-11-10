// The arrangement the chat home and the room drawer draw their lists from: the layout as sections,
// the server's order, and each room's latest activity.

import { useMemo } from "react";
import { useSelector } from "./app-store.ts";
import { activityAt } from "./rooms.ts";
import { type Sections, sections } from "./sections.ts";

export interface ChatsArrangement {
	/** The rooms have loaded. */
	listed: boolean;
	/** The server's order of the rooms, which settles a tie in activity. */
	order: string[];
	arrangement: Sections;
	/** A room's latest activity in epoch ms, below any real one for a room with none. */
	at(key: string): number;
}

/**
 * The home's arrangement as plain data. One string is selected, so a page redraws only when the
 * arrangement changes, not on every message; a message moves its room up, which changes it.
 */
export function useChatsArrangement(): ChatsArrangement {
	const shape = useSelector((state) =>
		JSON.stringify({
			listed: state.listed,
			order: state.order,
			...sections(state, (key) => activityAt(state, key)),
		}),
	);
	const { listed, order, ...arrangement } = useMemo(
		() => JSON.parse(shape) as { listed: boolean; order: string[] } & Sections,
		[shape],
	);
	const times = useSelector((state) =>
		JSON.stringify(
			Object.fromEntries(order.map((key) => [key, activityAt(state, key)])),
		),
	);
	const at = useMemo(() => {
		const known = JSON.parse(times) as Record<string, number>;
		return (key: string) => known[key] ?? Number.NEGATIVE_INFINITY;
	}, [times]);
	return { listed, order, arrangement, at };
}
