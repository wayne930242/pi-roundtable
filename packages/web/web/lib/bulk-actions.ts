// Marking every room read, and clearing every finished thread, across the rooms the list shows or a
// folder's. Loaded when an owner chooses either from a menu.

import { messageOf } from "./api.ts";
import { store } from "./app-store.ts";
import { bulkApi } from "./bulk-api.ts";
import { unreadIn } from "./bulk-items.ts";
import { seedUnread } from "./host-state.ts";
import { plural, translate as t } from "./messages.ts";
import { teamApi } from "./team-api.ts";
import { clearAcross } from "./thread-actions.ts";
import { toast } from "./toast.ts";

/** The most rooms one request names; the server refuses more. */
const PER_CALL = 500;

const chunks = <T>(items: readonly T[]): T[][] => {
	const parts: T[][] = [];
	for (let at = 0; at < items.length; at += PER_CALL)
		parts.push(items.slice(at, at + PER_CALL));
	return parts;
};

/** The list read again from the server: what a refusal or an undo leaves to be drawn. */
const refresh = () => store.dispatch({ type: "changed" });

/** Marks every unread room of `rooms` (a folder's), or of the whole list, read; a notice carries the undo. */
export async function markAllRead(rooms?: readonly string[]): Promise<void> {
	const counts = unreadIn(rooms);
	const keys = Object.keys(counts);
	if (keys.length === 0) return;
	const moved: Awaited<ReturnType<typeof bulkApi.readAll>>["moved"] = [];
	try {
		for (const part of chunks(keys))
			moved.push(...(await bulkApi.readAll(part)).moved);
	} catch (failure) {
		toast(messageOf(failure), "danger");
		refresh();
		return;
	}
	// The server also tells every page of the person; this one need not wait for it.
	seedUnread(Object.fromEntries(keys.map((key) => [key, 0])));
	toast(
		plural(
			keys.length,
			"Marked {count} room as read",
			"Marked {count} rooms as read",
		),
		"info",
		moved.length
			? { label: t("Undo"), run: () => void undoRead(moved, counts) }
			: undefined,
	);
}

/** Puts the cursors back where the marking found them; the counts return from what the page held. */
async function undoRead(
	moved: Awaited<ReturnType<typeof bulkApi.readAll>>["moved"],
	counts: Readonly<Record<string, number>>,
): Promise<void> {
	try {
		for (const part of chunks(moved)) {
			const { restored } = await bulkApi.unreadAll(part);
			seedUnread(
				Object.fromEntries(restored.map((room) => [room, counts[room] ?? 0])),
			);
		}
	} catch (failure) {
		toast(messageOf(failure), "danger");
	}
	refresh();
}

/** Clears every finished thread under `rooms` (a folder's), or under every room of the list. */
export const clearAllFinished = (rooms?: readonly string[]): Promise<void> =>
	clearAcross(rooms);

/** Puts back the temp knights an archive took, by name; a refusal is said, and the list is read again either way. */
export async function putBackHelpers(names: readonly string[]): Promise<void> {
	try {
		await bulkApi.restoreHelpers(names);
	} catch (failure) {
		toast(messageOf(failure), "danger");
	}
	refresh();
}

/**
 * "Clear finished temp knights" for `rooms` (a folder's or one knight's) or for every knight: it
 * archives at once, and the notice's Undo restores exactly the ones it archived.
 */
export async function clearFinishedHelpers(
	rooms?: readonly string[],
): Promise<void> {
	let names: string[];
	try {
		const answer = await bulkApi.archiveFinishedHelpers(rooms);
		names = answer.archived.flatMap((one) => one.names);
	} catch (failure) {
		toast(messageOf(failure), "danger");
		refresh();
		return;
	}
	refresh();
	if (names.length === 0) return;
	toast(
		plural(
			names.length,
			"Archived {count} temp knight",
			"Archived {count} temp knights",
		),
		"info",
		{ label: t("Undo"), run: () => void putBackHelpers(names) },
	);
}

/** Archives one temp knight, finished or not; the notice's Undo restores it. */
export async function archiveHelper(
	name: string,
	shown: string,
): Promise<void> {
	try {
		await teamApi.archiveAgent(name);
	} catch (failure) {
		toast(messageOf(failure), "danger");
		refresh();
		return;
	}
	refresh();
	toast(t("Archived {name}", { name: shown }), "info", {
		label: t("Undo"),
		run: () => void putBackHelpers([name]),
	});
}
