// Taking finished dispatch threads off the room list. Loaded when an owner presses a remove button,
// so the page that draws the list does not carry it.

import { api, messageOf } from "./api.ts";
import { store } from "./app-store.ts";
import { toast } from "./toast.ts";

/** Dismisses `threads` through `send`, and leaves them off the list at once; a refusal is said and the list read again. */
async function dismiss(
	threads: readonly string[],
	send: () => Promise<unknown>,
) {
	try {
		await send();
		store.dispatch({ type: "threads_dismissed", rooms: [...threads] });
	} catch (failure) {
		toast(messageOf(failure), "danger");
		store.dispatch({ type: "changed" });
	}
}

/** One finished thread. */
export const dismissThread = (thread: string) =>
	dismiss([thread], () => api.dismissThread(thread));

/** Every finished thread of `room`, the ones the list shows under it. */
export const dismissThreads = (room: string, threads: readonly string[]) =>
	dismiss(threads, () => api.dismissThreads(room));
