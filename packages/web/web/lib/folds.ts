// The folds kept for this device: which folders are folded in the room list. A device starts with every folder open.
// Loads with the folder block, the first time a folder is drawn.

import { signal } from "./signal.ts";

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
