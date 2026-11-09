import type { Speaker } from "pi-roundtable";
import { channelKey } from "pi-roundtable";
import type {
	ReadAllUndone,
	ReadAllView,
	ThreadsDismissed,
	ThreadsDismissedAll,
	ThreadsRestored,
} from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { MAX_READ_ALL } from "../host/read-all.ts";
import { json } from "../http.ts";
import { viewerOf } from "../web-app.ts";
import { bad, bodyOf, HttpError, notFound } from "./api-http.ts";
import type { ResolvedRoom } from "./rooms.ts";

import type { AppApiOptions } from "./routes-options.ts";

/** The most threads one request puts back on the room list: more than the list ever shows. */
const MAX_RESTORED = 100;

/** The most rooms one bulk request names. */
const MAX_BULK_ROOMS = MAX_READ_ALL;

/** A cursor move as the page sends it back to undo a marking. */
const isReadMove = (
	value: unknown,
): value is { room: string; from: number; to: number } => {
	if (typeof value !== "object" || value === null) return false;
	const { room, from, to } = value as Record<string, unknown>;
	return (
		typeof room === "string" &&
		room.length <= 300 &&
		Number.isSafeInteger(from) &&
		(from as number) >= 0 &&
		Number.isSafeInteger(to) &&
		(to as number) >= 0
	);
};

/** The calls that act on several rooms or threads at once: reading, dismissing and restoring them. */
export class RoomBulkApi {
	readonly #options: Pick<
		AppApiOptions,
		"host" | "rooms" | "threads" | "surface" | "changed"
	>;
	readonly #owner: (admission: Authenticated) => Promise<Speaker>;

	constructor(
		options: Pick<
			AppApiOptions,
			"host" | "rooms" | "threads" | "surface" | "changed"
		>,
		owner: (admission: Authenticated) => Promise<Speaker>,
	) {
		this.#options = options;
		this.#owner = owner;
	}

	/**
	 * Reads the person's rooms up to their newest message in one call: the named ones, or every room
	 * the list shows. A room they may not read is passed over as if it were not named. With `restore`
	 * instead, the cursors a call moved go back, where the person has not read on since.
	 */
	async readAll(request: Request, admission: Authenticated): Promise<Response> {
		const { host } = this.#options;
		if (!host) throw new HttpError(404, "There is no such API.");
		const viewer = viewerOf(admission.visitor);
		const body = await bodyOf(request);
		if (body.restore !== undefined) {
			const { restore } = body;
			if (
				!Array.isArray(restore) ||
				restore.length > MAX_BULK_ROOMS ||
				!restore.every(isReadMove)
			)
				throw bad("restore must be a list of at most 500 moves.");
			const restored = await host.unreadAll(viewer, restore);
			if (restored.length) this.#options.changed();
			return json({ restored } satisfies ReadAllUndone);
		}
		const named = await this.#named(body.rooms);
		const keys =
			named ?? (await this.#options.rooms.list()).map((one) => one.key);
		const moved = await host.readAll(viewer, keys);
		if (moved.length) this.#options.changed();
		return json({
			moved: moved.map(({ room, from, to }) => ({ room, from, to })),
		} satisfies ReadAllView);
	}

	/** Takes every finished thread under the named rooms, or under every room the list shows, off the list. */
	async dismissAllFinished(
		request: Request,
		admission: Authenticated,
	): Promise<Response> {
		await this.#owner(admission);
		const { rooms, threads, surface } = this.#options;
		const named = await this.#named((await bodyOf(request)).rooms);
		const listed = named ?? (await rooms.list()).map((one) => one.key);
		const parents: string[] = [];
		for (const key of new Set(listed)) {
			const one = await rooms.resolve(key);
			if (one && one.kind !== "thread") parents.push(one.key);
		}
		const dismissed = await threads.dismissFinishedUnder(parents);
		const byParent: Record<string, string[]> = {};
		for (const { id, parent } of dismissed)
			byParent[parent] = [
				...(byParent[parent] ?? []),
				channelKey(surface.surface, id),
			];
		if (dismissed.length) this.#options.changed();
		return json({
			dismissed: dismissed.length,
			threads: byParent,
		} satisfies ThreadsDismissedAll);
	}

	/** The room keys a bulk body names; undefined when it names none, meaning every room. */
	async #named(value: unknown): Promise<string[] | undefined> {
		if (value === undefined) return undefined;
		if (
			!Array.isArray(value) ||
			value.length > MAX_BULK_ROOMS ||
			!value.every((one) => typeof one === "string" && one.length <= 300)
		)
			throw bad("rooms must be a list of at most 500 keys.");
		return value;
	}

	/** Takes one finished thread off the room list for every owner; an open one is refused. */
	async dismiss(
		room: ResolvedRoom,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind !== "thread") throw notFound();
		await this.#owner(admission);
		const outcome = await this.#options.threads.dismiss(room.name);
		if (outcome === "missing") throw notFound();
		if (outcome === "open")
			throw new HttpError(409, "The thread is still open.");
		this.#options.changed();
		return json({ dismissed: 1 } satisfies ThreadsDismissed);
	}

	/** Takes every finished thread of a room off the room list; the open ones stay. */
	async dismissFinished(
		room: ResolvedRoom,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind === "thread") throw notFound();
		await this.#owner(admission);
		const dismissed = await this.#options.threads.dismissFinished(room.key);
		if (dismissed) this.#options.changed();
		return json({ dismissed } satisfies ThreadsDismissed);
	}

	/** Puts one dismissed thread back on the room list for every owner: the undo of a dismissal. */
	async restore(
		room: ResolvedRoom,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind !== "thread") throw notFound();
		await this.#owner(admission);
		const outcome = await this.#options.threads.restore(room.name);
		if (outcome === "missing") throw notFound();
		this.#options.changed();
		return json({ restored: 1 } satisfies ThreadsRestored);
	}

	/** Puts back the threads of a room that one clear-all dismissed, named by their keys. */
	async restoreFinished(
		room: ResolvedRoom,
		request: Request,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind === "thread") throw notFound();
		await this.#owner(admission);
		const { threads } = await bodyOf(request);
		if (
			!Array.isArray(threads) ||
			threads.length > MAX_RESTORED ||
			!threads.every((one) => typeof one === "string")
		)
			throw bad("threads must be a list of at most 100 keys.");
		// A key is `<surface>:<thread id>`; the store knows the id.
		const ids = threads.map((key: string) => key.slice(key.indexOf(":") + 1));
		const restored = await this.#options.threads.restoreFinished(room.key, ids);
		if (restored) this.#options.changed();
		return json({ restored } satisfies ThreadsRestored);
	}
}
