import { useSyncExternalStore } from "react";

// Whether a group room shows its conversation in the round table scene instead of the list. The
// choice is kept per room, in the browser's storage where there is some and for the page's life
// where there is not.

const KEY = (room: string) => `rt-table-mode:${room}`;
const kept = new Map<string, boolean>();
const listeners = new Set<() => void>();

function stored(room: string): boolean | undefined {
	try {
		const value = globalThis.localStorage?.getItem(KEY(room));
		return value === "1" ? true : value === "0" ? false : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the room is shown as the scene; the list when nothing was chosen. */
export function tableModeOf(room: string): boolean {
	const held = kept.get(room);
	if (held !== undefined) return held;
	const value = stored(room) ?? false;
	kept.set(room, value);
	return value;
}

export function setTableMode(room: string, on: boolean): void {
	kept.set(room, on);
	try {
		globalThis.localStorage?.setItem(KEY(room), on ? "1" : "0");
	} catch {
		// a browser that refuses storage keeps the choice for the page's life
	}
	for (const listener of listeners) listener();
}

/** Forgets what the page holds in memory (the storage stays); for tests. */
export function resetTableModes(): void {
	kept.clear();
	for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export function useTableMode(room: string): [boolean, (on: boolean) => void] {
	const on = useSyncExternalStore(
		subscribe,
		() => tableModeOf(room),
		() => false,
	);
	return [on, (next) => setTableMode(room, next)];
}
