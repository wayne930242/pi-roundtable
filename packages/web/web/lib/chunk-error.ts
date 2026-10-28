/** How long a reload for a failed chunk stands as the one: a second failure inside it shows the card instead. */
const RELOAD_WINDOW_MS = 60_000;
const RELOAD_KEY = "rt-chunk-reload";

const CHUNK_FAILURE =
	/dynamically imported module|importing a module script|loading chunk|loading css chunk|ChunkLoadError/i;

/** Whether an error is a page's code failing to load, as after a release replaced the files the open page names. */
export function isChunkError(error: unknown): boolean {
	const text =
		error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return CHUNK_FAILURE.test(text);
}

/**
 * Whether a failed chunk should reload the page now: once per window, so a chunk that stays
 * missing ends at the error card instead of a reload loop. `last` is the time of the previous
 * reload for this reason, as the storage kept it.
 */
export function shouldReloadFor(last: string | null, now: number): boolean {
	const before = Number(last);
	return !last || Number.isNaN(before) || now - before > RELOAD_WINDOW_MS;
}

/** Reloads the page for a failed chunk when that has not just been tried; false when it should show the card. */
export function reloadForChunk(
	storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
	now = Date.now(),
	reload: () => void = () => location.reload(),
): boolean {
	try {
		if (!shouldReloadFor(storage.getItem(RELOAD_KEY), now)) return false;
		storage.setItem(RELOAD_KEY, String(now));
	} catch {
		// No storage to remember it in: reloading could loop, so show the card.
		return false;
	}
	reload();
	return true;
}
