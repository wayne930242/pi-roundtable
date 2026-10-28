import { signal } from "./signal.ts";

/** The character kit: parts, composer and checks. */
export type Kit = typeof import("pi-roundtable/characters");

// The kit is about 19 KB gzipped, more than every other piece of the characters together, so it
// loads as a chunk of its own, started the moment the page's script runs. Drawings wait for it;
// the list of rooms and the profile are fetched through `loadKit`, so they never hand the page a
// character before there is something to check it with.
let kit: Kit | undefined;
let loading: Promise<Kit> | undefined;
const { emit, use } = signal();

export function loadKit(): Promise<Kit> {
	loading ??= import("pi-roundtable/characters").then((loaded) => {
		kit = loaded;
		emit();
		return loaded;
	});
	// A failed load can be tried again.
	loading.catch(() => {
		loading = undefined;
	});
	return loading;
}

/** The kit once it has loaded; the component draws again then. */
export function useKit(): Kit | undefined {
	return use(() => kit);
}
