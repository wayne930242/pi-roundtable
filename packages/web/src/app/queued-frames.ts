import type { ChannelKey, ConversationPort } from "pi-roundtable";
import {
	type ClientFrame,
	MAX_MESSAGE_CHARS,
	type RefusalCode,
} from "../api-types.ts";
import type { Answerer } from "./desk.ts";
import { coreMessageId } from "./queued-delivery.ts";
import type { Rooms } from "./rooms.ts";
import type { AppSurface } from "./surface.ts";

export interface QueuedFrameDeps {
	rooms: Pick<Rooms, "resolve">;
	surface: Pick<AppSurface, "delivery" | "edit">;
	conversations: Pick<ConversationPort, "cancelQueued" | "editQueued">;
}

/**
 * An owner's request to edit or cancel a message of theirs that waits for its turn. The room must
 * be one of the app's, the message theirs, and the host must still hold it in the queue: once its
 * turn has started the answer is `not_queued`, and nothing changes. An edit shows the new text in
 * the room as an edited message; a cancel keeps the message, marked cancelled.
 */
export async function changeQueued(
	frame: Extract<ClientFrame, { type: "edit_queued" | "cancel_queued" }>,
	who: Answerer,
	deps: QueuedFrameDeps,
): Promise<RefusalCode | undefined> {
	if (who.tier !== "owner") return "forbidden";
	const room = await deps.rooms.resolve(frame.room);
	if (!room) return "unknown_room";
	if (room.readOnly) return "read_only";
	return inTurn(deps.surface, room.key, () =>
		apply(frame, who, deps, room.key),
	);
}

/** The changes of one room per surface, each waiting for the one before it. */
const lines = new WeakMap<
	QueuedFrameDeps["surface"],
	Map<string, Promise<unknown>>
>();

/**
 * Runs `change` after every change already asked for in the room has finished. The host takes an
 * edit at once but the room's log is written a moment later; two edits from two sockets would
 * otherwise land in the log in either order, and the room would show a text the turn does not use.
 */
function inTurn<T>(
	owner: QueuedFrameDeps["surface"],
	room: string,
	change: () => Promise<T>,
): Promise<T> {
	let rooms = lines.get(owner);
	if (!rooms) {
		rooms = new Map();
		lines.set(owner, rooms);
	}
	const before = rooms.get(room) ?? Promise.resolve();
	const result = before.then(change, change);
	const tail = result.catch(() => undefined);
	rooms.set(room, tail);
	// A room with nothing waiting leaves no entry behind.
	tail.then(() => {
		if (rooms.get(room) === tail) rooms.delete(room);
	});
	return result;
}

async function apply(
	frame: Extract<ClientFrame, { type: "edit_queued" | "cancel_queued" }>,
	who: Answerer,
	deps: QueuedFrameDeps,
	roomKey: ChannelKey,
): Promise<RefusalCode | undefined> {
	const room = { key: roomKey };
	const stored = await deps.surface.delivery.stored(room.key, frame.message);
	if (stored?.kind !== "owner") return "not_queued";
	if (stored.principalId !== who.principalId) return "forbidden";
	const by = { principalId: who.principalId };
	const messageId = coreMessageId(stored.id);
	if (frame.type === "cancel_queued")
		return refusalOf(
			await deps.surface.delivery.cancel(
				room.key,
				stored.id,
				() =>
					deps.conversations.cancelQueued?.(room.key, messageId, by) ??
					"unknown",
			),
		);
	// The block shows what the answer picked; a changed text would leave it showing the old pick.
	if (stored.answer) return "answer_locked";
	const text = frame.text.trim();
	if (text.length > MAX_MESSAGE_CHARS) return "too_long";
	if (text === "" && stored.files.length === 0) return "empty";
	const change =
		deps.conversations.editQueued?.(room.key, messageId, by, text) ?? "unknown";
	if (change === "done")
		await deps.surface.edit(room.key, stored.id, text, true);
	return refusalOf(change);
}

function refusalOf(
	change: "done" | "unknown" | "forbidden" | "refused",
): RefusalCode | undefined {
	switch (change) {
		case "done":
			return undefined;
		case "unknown":
			return "not_queued";
		case "forbidden":
			return "forbidden";
		case "refused":
			return "not_accepted";
	}
}
