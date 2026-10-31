import type { RoomMessage } from "../../src/api-types.ts";
import { signal } from "./signal.ts";

let current: RoomMessage | undefined;
const { emit, use } = signal();

/** Asks to edit a message that waits for its turn; `QueuedEditHost` draws the form. */
export function askQueuedEdit(message: RoomMessage): void {
	current = message;
	emit();
}

export function clearQueuedEdit(): void {
	if (!current) return;
	current = undefined;
	emit();
}

export const useQueuedEdit = (): RoomMessage | undefined => use(() => current);
