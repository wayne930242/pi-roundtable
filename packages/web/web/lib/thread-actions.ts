// Taking finished dispatch threads off the room list, and putting them back. Loaded when an owner
// swipes, presses or asks a card's menu, so the page that draws the list does not carry it.

import { api, messageOf } from "./api.ts";
import { store } from "./app-store.ts";
import { plural, translate as t } from "./messages.ts";
import { askRoomConfirm } from "./room-confirm.ts";
import { toast } from "./toast.ts";

/** A clear-all of more finished threads than this asks first, with the count. */
export const CONFIRM_ABOVE = 5;

/** The list read again from the server: what a refusal or an undo leaves to be drawn. */
const refresh = () => store.dispatch({ type: "changed" });

/** Takes back what a dismissal removed, through `send`; a refusal is said and the list read again. */
async function undo(send: () => Promise<unknown>): Promise<void> {
	try {
		await send();
	} catch (failure) {
		toast(messageOf(failure), "danger");
	}
	refresh();
}

/**
 * Dismisses `threads` through `send` and leaves them off the list at once, with a notice that undoes
 * it. False when the server refused: the refusal is said, the list read again, and nothing left.
 */
async function dismiss(
	threads: readonly string[],
	send: () => Promise<unknown>,
	said: string,
	restore: () => Promise<unknown>,
): Promise<boolean> {
	try {
		await send();
	} catch (failure) {
		toast(messageOf(failure), "danger");
		refresh();
		return false;
	}
	store.dispatch({ type: "threads_dismissed", rooms: [...threads] });
	toast(said, "info", { label: t("Undo"), run: () => void undo(restore) });
	return true;
}

/** One finished thread. */
export function dismissThread(thread: string): Promise<boolean> {
	const name = store.getState().rooms[thread]?.view?.displayName ?? thread;
	return dismiss(
		[thread],
		() => api.dismissThread(thread),
		t("Cleared “{name}”", { name }),
		() => api.undismissThread(thread),
	);
}

/**
 * Every finished thread of `room`, the ones the list shows under it (`threads`). Threads whose room
 * the list no longer has are cleared one by one.
 */
export function dismissThreads(
	room: string | undefined,
	threads: readonly string[],
): Promise<boolean> {
	return dismiss(
		threads,
		() =>
			room
				? api.dismissThreads(room)
				: Promise.all(threads.map((one) => api.dismissThread(one))),
		plural(
			threads.length,
			"Cleared {count} finished thread",
			"Cleared {count} finished threads",
		),
		() =>
			room
				? api.undismissThreads(room, threads)
				: Promise.all(threads.map((one) => api.undismissThread(one))),
	);
}

/** "Clear all finished": at once for a few, after a question with the count for many. */
export async function clearFinished(
	room: string | undefined,
	threads: readonly string[],
): Promise<void> {
	if (threads.length === 0) return;
	if (threads.length <= CONFIRM_ABOVE) {
		await dismissThreads(room, threads);
		return;
	}
	askRoomConfirm({
		kind: "clear-threads",
		room: room ?? "",
		name: "",
		threads,
	});
}
