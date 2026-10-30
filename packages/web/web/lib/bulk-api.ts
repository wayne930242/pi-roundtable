import type {
	ReadAllUndone,
	ReadAllView,
	ReadMove,
	ThreadsDismissedAll,
} from "../../src/api-types.ts";
import { request } from "./api.ts";

/** The owner-only routes that act on many rooms at once; loads with the first such action. */
export const bulkApi = {
	/** Clears the finished threads under each of `rooms` off the room list; names what it cleared, room by room. */
	dismissAllFinished: (rooms: readonly string[]) =>
		request<ThreadsDismissedAll>("rooms/dismiss-finished-threads", {
			method: "POST",
			body: JSON.stringify({ rooms }),
		}),
	/** Reads each of `rooms` up to its newest message; names the cursors that moved. */
	readAll: (rooms: readonly string[]) =>
		request<ReadAllView>("rooms/read-all", {
			method: "POST",
			body: JSON.stringify({ rooms }),
		}),
	/** Puts back cursors a `readAll` moved, where nothing was read on since. */
	unreadAll: (moves: readonly ReadMove[]) =>
		request<ReadAllUndone>("rooms/read-all", {
			method: "POST",
			body: JSON.stringify({ restore: moves }),
		}),
};
