import { signal } from "./signal.ts";

// How this device shows the round table: whether the scene's dialogue box is folded to its bar, and
// whether the table page plays the scene or lists the council's messages as a chat. Both are kept in
// the browser's storage where there is some, and for the page's life where there is not.

export const DIALOGUE_FOLDED_KEY = "roundtable-console:dialogue-folded";
export const TABLE_MODE_KEY = "roundtable-console:table-mode";

/** The table page plays the scene with its dialogue box, or lists the council's messages as a chat. */
export type TablePageMode = "scene" | "chat";

const kept = new Map<string, string>();
const { emit, use } = signal();

function read(key: string): string | undefined {
	const held = kept.get(key);
	if (held !== undefined) return held;
	try {
		const value = globalThis.localStorage?.getItem(key) ?? undefined;
		if (value !== undefined) kept.set(key, value);
		return value;
	} catch {
		return undefined;
	}
}

function write(key: string, value: string): void {
	kept.set(key, value);
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch {
		// a browser that refuses storage keeps the choice for the page's life
	}
	emit();
}

export const dialogueFolded = (): boolean => read(DIALOGUE_FOLDED_KEY) === "1";

export function setDialogueFolded(folded: boolean): void {
	write(DIALOGUE_FOLDED_KEY, folded ? "1" : "0");
}

export const tablePageMode = (): TablePageMode =>
	read(TABLE_MODE_KEY) === "chat" ? "chat" : "scene";

export function setTablePageMode(mode: TablePageMode): void {
	write(TABLE_MODE_KEY, mode);
}

/** Whether the dialogue box is folded to its bar on this device; open until it is folded. */
export function useDialogueFolded(): [boolean, (folded: boolean) => void] {
	return [use(dialogueFolded), setDialogueFolded];
}

/** How the table page shows its council on this device; the scene until chat is chosen. */
export function useTablePageMode(): [
	TablePageMode,
	(mode: TablePageMode) => void,
] {
	return [use(tablePageMode), setTablePageMode];
}

/** Forgets what the page holds in memory (the storage stays); for tests. */
export function resetTableView(): void {
	kept.clear();
	emit();
}
