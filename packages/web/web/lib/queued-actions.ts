import type { RoomMessage } from "../../src/api-types.ts";
import { APP_PROTOCOL } from "../../src/api-types.ts";
import { store } from "./app-store.ts";
import { startConnection } from "./socket.ts";

/** The page's open connection: the one it started is returned as it is. */
const connection = () => startConnection(APP_PROTOCOL);

/** Whether the person wrote the message and its turn has not started, so it can still be edited or cancelled. */
export function canChangeQueued(message: RoomMessage): boolean {
	return (
		message.kind === "owner" &&
		message.delivery === "queued" &&
		message.principalId !== undefined &&
		message.principalId === store.getState().principal?.id
	);
}

/** Cancels the waiting message; the room shows it cancelled, or a notice says it was too late. */
export function cancelQueued(message: RoomMessage): void {
	connection().send({
		type: "cancel_queued",
		room: message.room,
		message: message.id,
	});
}

/** Replaces the waiting message's text; the room shows the new text, or a notice says it was too late. */
export function editQueued(message: RoomMessage, text: string): void {
	connection().send({
		type: "edit_queued",
		room: message.room,
		message: message.id,
		text,
	});
}
