// Taking finished dispatch threads off the room list, and putting them back. Loaded when an owner
// swipes, presses or asks a card's menu, so the page that draws the list does not carry it.

import { api, messageOf } from "./api.ts";
import { store } from "./app-store.ts";
import { bulkApi } from "./bulk-api.ts";
import { finishedUnder } from "./finished-threads.ts";
import { plural, translate as t } from "./messages.ts";
import { toast } from "./toast.ts";

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

/** The notice's undo of a clear-all across rooms: each room's threads go back through the room's own route. */
const putBack = (done: Readonly<Record<string, string[]>>) =>
	Promise.all(
		Object.entries(done).flatMap(([room, keys]) =>
			Array.from(
				{ length: Math.ceil(keys.length / RESTORE_AT_ONCE) },
				(_, at) =>
					api.undismissThreads(
						room,
						keys.slice(at * RESTORE_AT_ONCE, (at + 1) * RESTORE_AT_ONCE),
					),
			),
		),
	);

/** The most threads the server puts back in one request. */
const RESTORE_AT_ONCE = 100;
/** The most rooms the server clears in one request. */
const ROOMS_AT_ONCE = 500;

/**
 * Every finished thread under `parents`, in one call per 500 rooms. What the server cleared is what
 * the notice's Undo brings back, room by room. False when the server refused.
 */
export async function dismissAcross(
	parents: readonly string[],
): Promise<boolean> {
	const done: Record<string, string[]> = {};
	let dismissed = 0;
	try {
		for (let at = 0; at < parents.length; at += ROOMS_AT_ONCE) {
			const answer = await bulkApi.dismissAllFinished(
				parents.slice(at, at + ROOMS_AT_ONCE),
			);
			dismissed += answer.dismissed;
			for (const [room, keys] of Object.entries(answer.threads))
				done[room] = [...(done[room] ?? []), ...keys];
		}
	} catch (failure) {
		toast(messageOf(failure), "danger");
	}
	const cleared = Object.values(done).flat();
	if (cleared.length === 0) {
		refresh();
		return dismissed > 0;
	}
	store.dispatch({ type: "threads_dismissed", rooms: cleared });
	toast(
		plural(
			cleared.length,
			"Cleared {count} finished thread",
			"Cleared {count} finished threads",
		),
		"info",
		{ label: t("Undo"), run: () => void undo(() => putBack(done)) },
	);
	return true;
}

/**
 * "Clear all finished threads" across rooms: the folder's `rooms`, or every room of the list. It
 * clears at once; the notice's Undo is the way back.
 */
export async function clearAcross(rooms?: readonly string[]): Promise<void> {
	const byRoom = finishedUnder(rooms);
	if (byRoom.size === 0) return;
	await dismissAcross([...byRoom.keys()]);
}

/** "Clear all finished" in one room: at once; the notice's Undo is the way back. */
export async function clearFinished(
	room: string | undefined,
	threads: readonly string[],
): Promise<void> {
	if (threads.length === 0) return;
	await dismissThreads(room, threads);
}
