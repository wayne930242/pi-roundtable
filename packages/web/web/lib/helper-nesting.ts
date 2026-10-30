import type { RoomView } from "../../src/api-types.ts";

/** Whether the view is a temp knight whose knight's room the list holds: it shows under that room, like a thread, not as a room of its own. */
export function nestedHelper(
	view: RoomView | undefined,
	listed: { has(key: string): boolean },
): view is RoomView & { helper: { parent: string } } {
	return view?.helper !== undefined && listed.has(view.helper.parent);
}
