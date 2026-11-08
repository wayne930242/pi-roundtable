import type { RoomMessage } from "../../src/api-types.ts";
import { APP_PROTOCOL } from "../../src/api-types.ts";
import type { MenuItem } from "./action-menu.ts";
import { store } from "./app-store.ts";
import { translate as t } from "./messages.ts";
import { askQueuedEdit } from "./queued-edit.ts";
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

/** Whether the person can also change its text: not a message that carries the answer to a block, whose block would keep the old pick. */
export function canEditQueued(message: RoomMessage): boolean {
	return canChangeQueued(message) && message.answer !== true;
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

/** What a message's menu offers for a waiting message of the person's own: Edit unless it carries a block answer, and Cancel. */
export function queuedItems(message: RoomMessage): MenuItem[] {
	const items: MenuItem[] = [];
	if (canEditQueued(message))
		items.push({
			id: "edit-queued",
			label: t("Edit"),
			icon: "notes",
			run: () => askQueuedEdit(message),
		});
	if (canChangeQueued(message))
		items.push({
			id: "cancel-queued",
			label: t("Cancel"),
			icon: "close",
			tone: "danger",
			run: () => cancelQueued(message),
		});
	return items;
}
