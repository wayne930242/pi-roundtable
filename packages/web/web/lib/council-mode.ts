import { signal } from "./signal.ts";

// How a council shows: its round table scene with the dialogue box, or its group room's messages as
// a chat. The choice is kept per council room, the same whether the group's room or the round table
// shows it, in the browser's storage where there is some and for the page's life where there is not.

/** The council plays the scene with its dialogue box, or lists its messages as a chat. */
export type CouncilMode = "scene" | "chat";

export const COUNCIL_MODE_KEY = (room: string) =>
	`roundtable-console:council-mode:${room}`;
/** Where a group room kept its "Table" toggle before the council view: "1" the scene, "0" the list. */
export const OLD_ROOM_TOGGLE_KEY = (room: string) => `rt-table-mode:${room}`;
/** Where the table page kept its mode for the whole device before the council view. */
export const OLD_TABLE_MODE_KEY = "roundtable-console:table-mode";

const kept = new Map<string, CouncilMode>();
const { emit, use } = signal();

const modeOf = (value: string | null | undefined): CouncilMode | undefined =>
	value === "scene" || value === "chat" ? value : undefined;

function stored(key: string): string | undefined {
	try {
		return globalThis.localStorage?.getItem(key) ?? undefined;
	} catch {
		return undefined;
	}
}

function store(key: string, value: string | undefined): void {
	try {
		if (value === undefined) globalThis.localStorage?.removeItem(key);
		else globalThis.localStorage?.setItem(key, value);
	} catch {
		// a browser that refuses storage keeps the choice for the page's life
	}
}

/**
 * A council read for the first time takes what the room's old toggle said, else what the table
 * page's old mode said; the room's old key goes once its value is moved. Nothing chosen anywhere
 * is the scene.
 */
function migrated(room: string): CouncilMode {
	const toggle = stored(OLD_ROOM_TOGGLE_KEY(room));
	const fromToggle =
		toggle === "1" ? "scene" : toggle === "0" ? "chat" : undefined;
	const mode =
		fromToggle ?? modeOf(stored(OLD_TABLE_MODE_KEY)) ?? ("scene" as const);
	if (fromToggle !== undefined || modeOf(stored(OLD_TABLE_MODE_KEY))) {
		store(COUNCIL_MODE_KEY(room), mode);
		store(OLD_ROOM_TOGGLE_KEY(room), undefined);
	}
	return mode;
}

/** How the council of this room shows. */
export function councilModeOf(room: string): CouncilMode {
	const held = kept.get(room);
	if (held !== undefined) return held;
	const mode = modeOf(stored(COUNCIL_MODE_KEY(room))) ?? migrated(room);
	kept.set(room, mode);
	return mode;
}

export function setCouncilMode(room: string, mode: CouncilMode): void {
	kept.set(room, mode);
	store(COUNCIL_MODE_KEY(room), mode);
	emit();
}

export function useCouncilMode(
	room: string,
): [CouncilMode, (mode: CouncilMode) => void] {
	return [use(() => councilModeOf(room)), (mode) => setCouncilMode(room, mode)];
}

/** Forgets what the page holds in memory (the storage stays); for tests. */
export function resetCouncilModes(): void {
	kept.clear();
	emit();
}
