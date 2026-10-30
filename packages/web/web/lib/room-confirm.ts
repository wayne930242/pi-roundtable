import { signal } from "./signal.ts";

/** A question the page asks before a room changes in a way that is hard to undo. */
export interface RoomConfirm {
	kind: "yolo" | "start-over" | "archive" | "clear-threads";
	room: string;
	name: string;
	/** For `clear-threads`: the finished threads the answer clears. */
	threads?: readonly string[];
	/** Where focus goes once the question is gone, for an asker that is no longer in the page. */
	restoreFocus?(): HTMLElement | null;
}

let current: RoomConfirm | undefined;
const { emit, use } = signal();

/** Asks the question; `RoomConfirmHost` draws it. */
export function askRoomConfirm(ask: RoomConfirm): void {
	current = ask;
	emit();
}

export function clearRoomConfirm(): void {
	if (!current) return;
	current = undefined;
	emit();
}

export const useRoomConfirm = (): RoomConfirm | undefined => use(() => current);
