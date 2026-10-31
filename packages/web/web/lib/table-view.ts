import { signal } from "./signal.ts";

// Whether the round table scene's dialogue box is folded to its bar on this device. It is kept in the
// browser's storage where there is some, and for the page's life where there is not.

export const DIALOGUE_FOLDED_KEY = "roundtable-console:dialogue-folded";

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

/** Whether the dialogue box is folded to its bar on this device; open until it is folded. */
export function useDialogueFolded(): [boolean, (folded: boolean) => void] {
	return [use(dialogueFolded), setDialogueFolded];
}

/** Forgets what the page holds in memory (the storage stays); for tests. */
export function resetTableView(): void {
	kept.clear();
	emit();
}
