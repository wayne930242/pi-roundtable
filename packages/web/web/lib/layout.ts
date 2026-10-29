// What the room list needs at once: the folds kept for this device, and what a lifted row or folder
// does. The edits themselves (`layout-actions.ts`) load when the first one is made.

import type { LayoutView } from "../../src/api-types.ts";
import { store } from "./app-store.ts";
import { activityAt } from "./rooms.ts";
import type { Lifting } from "./row-press.ts";
import { type Sections, sections } from "./sections.ts";
import { signal } from "./signal.ts";

const actions = () => import("./layout-actions.ts");

/** The layout the page holds now. */
export const layoutNow = (): LayoutView => {
	const { pins, folders } = store.getState();
	return { pins, folders };
};

/** The arrangement of the list as the page shows it now. */
export function arrangementNow(): Sections {
	const state = store.getState();
	return sections(state, (key) => activityAt(state, key));
}

/** What a lifted room row or folder block does: where it may be dropped, and what a drop does. */
export const roomLifting = (key: string): Lifting => ({
	mode: "room",
	key,
	item: (source) => source.closest<HTMLElement>("[data-drop-item]"),
	root: (source) => source.closest<HTMLElement>("[data-drop-root]"),
	onDrop: (outcome) => {
		if (outcome.type === "room")
			void actions().then((one) => one.dropRoom(key, outcome.drop));
	},
	open: expandFolder,
});

export const folderLifting = (id: string): Lifting => ({
	mode: "folder",
	key: id,
	item: (source) => source.closest<HTMLElement>("[data-folder-block]"),
	root: (source) =>
		source.closest<HTMLElement>("[data-folder-block]")?.parentElement ?? null,
	onDrop: (outcome) => {
		if (outcome.type === "folder")
			void actions().then((one) => one.placeFolderBefore(id, outcome.before));
	},
	open: expandFolder,
});

// ── Collapsed folders: per device ────────────────────────────────────────────────────────────

export const COLLAPSED_KEY = "roundtable-console:folders-collapsed";

function loadCollapsed(): ReadonlySet<string> {
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		const value: unknown = raw ? JSON.parse(raw) : [];
		return new Set(
			Array.isArray(value)
				? value.filter((one): one is string => typeof one === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

let collapsed: ReadonlySet<string> | undefined;
const { emit, use } = signal();

const held = (): ReadonlySet<string> => {
	collapsed ??= loadCollapsed();
	return collapsed;
};

function keep(next: ReadonlySet<string>): void {
	collapsed = next;
	try {
		localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
	} catch {
		// A browser that refuses storage keeps the folds for this page only.
	}
	emit();
}

/** The folders folded on this device. A device starts with every folder open. */
export const useCollapsed = (): ReadonlySet<string> => use(held);

export function toggleCollapsed(id: string): void {
	const next = new Set(held());
	if (!next.delete(id)) next.add(id);
	keep(next);
}

/** Opens a folded folder on this device. */
export function expandFolder(id: string): void {
	if (!held().has(id)) return;
	const next = new Set(held());
	next.delete(id);
	keep(next);
}

/** Forgets the folded folders that no longer exist, once the list is known. */
export function pruneCollapsed(existing: readonly string[]): void {
	const live = new Set(existing);
	const now = held();
	if ([...now].every((id) => live.has(id))) return;
	keep(new Set([...now].filter((id) => live.has(id))));
}

/** Re-reads the folds from storage; for a test that changes it. */
export function reloadCollapsed(): void {
	collapsed = undefined;
	emit();
}
