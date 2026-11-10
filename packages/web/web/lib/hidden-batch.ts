// What the hidden and archived page does with a selection: the batches of each section (unhide,
// dismiss, restore, delete for good), and how a knight and its temp knights are chosen together.

import type { ArchivedEntry } from "../../src/api-types.ts";
import { api } from "./api.ts";
import { store } from "./app-store.ts";
import type { Batch } from "./batch.ts";
import { hideRoom } from "./layout-actions.ts";
import { plural, translate as t } from "./messages.ts";
import { refreshRooms, teamApi } from "./team-api.ts";

/** An entry's id among the chosen: a knight's name and a group's may be the same word. */
export const entryId = (entry: Pick<ArchivedEntry, "kind" | "name">): string =>
	`${entry.kind}:${entry.name}`;

/** The archived temp knights of the knight called `name`. */
const helpersOf = (entries: readonly ArchivedEntry[], name: string) =>
	entries.filter((one) => one.parent === name);

/**
 * `entry` chosen or not chosen. A knight is chosen with its temp knights, as a group, and not chosen
 * with them; a temp knight whose knight is chosen cannot be left out, because the knight's delete
 * takes it along.
 */
export function toggleEntry(
	chosen: ReadonlySet<string>,
	entries: readonly ArchivedEntry[],
	entry: ArchivedEntry,
): ReadonlySet<string> {
	if (entry.parent !== undefined && chosen.has(`agent:${entry.parent}`))
		return chosen;
	const next = new Set(chosen);
	const group = [
		entry,
		...(entry.kind === "agent" ? helpersOf(entries, entry.name) : []),
	];
	if (next.has(entryId(entry)))
		for (const one of group) next.delete(entryId(one));
	else for (const one of group) next.add(entryId(one));
	return next;
}

/** The entries of `entries` that are chosen, a knight before its temp knights. */
export function chosenIn(
	entries: readonly ArchivedEntry[],
	chosen: ReadonlySet<string>,
): ArchivedEntry[] {
	const parents = entries.filter((one) => one.parent === undefined);
	const helpers = entries.filter((one) => one.parent !== undefined);
	return [...parents, ...helpers].filter((one) => chosen.has(entryId(one)));
}

/**
 * What deleting the chosen entries does: `send` are the deletes to make (a temp knight whose knight
 * is chosen is not sent, because the knight's delete removes it), and `gone` is everything that
 * disappears, the temp knights of a chosen knight included even when the age filter hid them.
 */
export function deletion(
	entries: readonly ArchivedEntry[],
	chosen: ReadonlySet<string>,
): { send: ArchivedEntry[]; gone: ArchivedEntry[] } {
	const picked = chosenIn(entries, chosen);
	const send = picked.filter(
		(one) => one.parent === undefined || !chosen.has(`agent:${one.parent}`),
	);
	const gone = [...picked];
	for (const one of send)
		if (one.kind === "agent")
			for (const helper of helpersOf(entries, one.name))
				if (!gone.includes(helper)) gone.push(helper);
	return { send, gone };
}

/** After a batch on the archive: the room list and the archive are read again. */
const archiveAfter = (reload: () => Promise<void>) => async () => {
	await refreshRooms();
	await reload();
};

export function unhideBatch(
	keys: readonly string[],
	nameOf: (key: string) => string,
): Batch<string> {
	return {
		label: t("Unhiding"),
		items: keys,
		nameOf,
		run: async (key) => {
			const said: string[] = [];
			if (!(await hideRoom(key, false, (words) => said.push(words))))
				throw new Error(said[0] ?? t("The room could not be shown again."));
		},
		said: (count) => plural(count, "Unhid {count} room", "Unhid {count} rooms"),
		undo: async (done) => {
			for (const key of done) await hideRoom(key, true);
		},
		after: () => undefined,
	};
}

export function dismissBatch(
	keys: readonly string[],
	nameOf: (key: string) => string,
): Batch<string> {
	return {
		label: t("Clearing"),
		items: keys,
		nameOf,
		run: async (key) => {
			await api.dismissThread(key);
			store.dispatch({ type: "threads_dismissed", rooms: [key] });
		},
		said: (count) =>
			plural(count, "Cleared {count} thread", "Cleared {count} threads"),
		undo: async (done) => {
			for (const key of done) await api.undismissThread(key);
		},
		after: () => void store.dispatch({ type: "changed" }),
	};
}

export function restoreBatch(
	entries: readonly ArchivedEntry[],
	reload: () => Promise<void>,
): Batch<ArchivedEntry> {
	return {
		label: t("Restoring"),
		items: entries,
		nameOf: (entry) => entry.displayName,
		run: (entry) =>
			entry.kind === "agent"
				? teamApi.restoreAgent(entry.name)
				: teamApi.restoreGroup(entry.name),
		said: (count) =>
			plural(count, "Restored {count} entry", "Restored {count} entries"),
		// Temp knights go back first, so a knight is archived with none left active under it.
		undo: async (done) => {
			for (const entry of [...done].reverse())
				await (entry.kind === "agent"
					? teamApi.archiveAgent(entry.name)
					: teamApi.archiveGroup(entry.name));
		},
		after: archiveAfter(reload),
	};
}

export function deleteBatch(
	entries: readonly ArchivedEntry[],
	reload: () => Promise<void>,
): Batch<ArchivedEntry> {
	return {
		label: t("Deleting"),
		items: entries,
		nameOf: (entry) => entry.displayName,
		run: (entry) =>
			entry.kind === "agent"
				? teamApi.deleteAgent(entry.name)
				: teamApi.deleteGroup(entry.name),
		said: (count) =>
			plural(count, "Deleted {count} entry", "Deleted {count} entries"),
		after: archiveAfter(reload),
	};
}
