import type { Speaker } from "pi-roundtable";
import type { ApiError, LayoutView } from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { json } from "../http.ts";
import {
	createFolder,
	LayoutError,
	placeFolder,
	placeRoom,
	removeFolder,
	renameFolder,
	setPinned,
	shown,
} from "../layout-order.ts";
import { readLimited } from "../request-body.ts";
import type { LayoutStore } from "./layout.ts";
import type { ResolvedRoom } from "./rooms.ts";

/** The largest JSON body of a layout write: 4 KiB. */
const MAX_BODY_BYTES = 4 * 1024;
const FOLDER_ID = /^folder\.[0-9a-f-]{36}$/;

/** A refusal with the status the owner is answered with. */
class LayoutRefusal extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const bad = (message: string) => new LayoutRefusal(400, message);

/** A refusal of the pure layout edits as the answer the owner reads. */
function refusalOf(error: LayoutError): LayoutRefusal {
	switch (error.code) {
		case "bad-name":
			return new LayoutRefusal(
				400,
				"Give the folder a name of 1 to 40 characters.",
			);
		case "no-folder":
			return new LayoutRefusal(404, "There is no such folder.");
		case "duplicate":
			return new LayoutRefusal(409, "A folder of that name exists.");
		case "full":
			return new LayoutRefusal(409, "There are 50 folders already.");
	}
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
	const raw = await readLimited(request, MAX_BODY_BYTES);
	if (!raw) throw new LayoutRefusal(413, "The body is too large.");
	let value: unknown;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch {
		throw bad("The body is not JSON.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw bad("The body is not an object.");
	return value as Record<string, unknown>;
}

/** `before` of a body: a key or id, none for the end; anything else is refused. */
function beforeOf(body: Record<string, unknown>): string | null {
	const { before } = body;
	if (before === undefined || before === null) return null;
	if (typeof before !== "string") throw bad("before must be a key or null.");
	return before;
}

export interface LayoutRoutesOptions {
	layout: LayoutStore;
	/** The keys of the rooms that may be placed: the active agents' and groups' rooms but Home. */
	placeable(): ReadonlySet<string>;
	/** Home's key, which stays at the top. */
	home(): string | undefined;
	/** Reads the person's tier again; refuses with 403 when they are no owner. */
	owner(admission: Authenticated): Promise<Speaker>;
	/** Called after a change the other pages should refetch. */
	changed(): void;
}

/**
 * The room list's arrangement over HTTP: `GET api/rooms` carries it, `api/folders` makes, renames,
 * places and removes folders, and `PUT api/rooms/<key>/folder` and `…/pin` place one room. Every
 * write is an owner's (tier read again) and answers with the whole layout, so the writing page
 * and the others converge on what the server stored.
 */
export class LayoutRoutes {
	readonly #options: LayoutRoutesOptions;

	constructor(options: LayoutRoutesOptions) {
		this.#options = options;
	}

	/** The layout as readers see it: only the rooms that exist. */
	async view(): Promise<LayoutView> {
		const rooms = this.#options.placeable();
		return shown(await this.#options.layout.view(), (key) => rooms.has(key));
	}

	/** `api/folders` and `api/folders/<id>`; `parts` is the path split after the mount. */
	async folders(
		request: Request,
		parts: string[],
		admission: Authenticated,
	): Promise<Response> {
		return this.#guard(async () => {
			const { method } = request;
			const [, , id] = parts;
			if (parts.length > 3) throw new LayoutRefusal(404, notAnApi);
			if (!id) {
				if (method !== "POST") throw new LayoutRefusal(405, notAllowed);
				await this.#options.owner(admission);
				const { name } = await bodyOf(request);
				if (typeof name !== "string")
					throw new LayoutRefusal(
						400,
						"Give the folder a name of 1 to 40 characters.",
					);
				const folder = `folder.${crypto.randomUUID()}`;
				return json(
					await this.#write((layout) => createFolder(layout, folder, name)),
					201,
				);
			}
			if (method !== "PATCH" && method !== "DELETE")
				throw new LayoutRefusal(405, notAllowed);
			await this.#options.owner(admission);
			if (!FOLDER_ID.test(id))
				throw new LayoutRefusal(404, "There is no such folder.");
			if (method === "DELETE")
				return json(await this.#write((layout) => removeFolder(layout, id)));
			const body = await bodyOf(request);
			const { name } = body;
			if (name !== undefined && typeof name !== "string")
				throw bad("name must be text.");
			const placed = "before" in body;
			if (name === undefined && !placed) throw bad("Give a name or a place.");
			const before = beforeOf(body);
			return json(
				await this.#write((layout) => {
					let next = layout;
					if (name !== undefined) next = renameFolder(next, id, name);
					if (placed) next = placeFolder(next, id, before);
					return next;
				}),
			);
		});
	}

	/** `PUT api/rooms/<key>/folder` and `…/pin`, for a room that resolved. */
	async place(
		request: Request,
		room: ResolvedRoom,
		action: "folder" | "pin",
		admission: Authenticated,
	): Promise<Response> {
		return this.#guard(async () => {
			await this.#options.owner(admission);
			if (room.kind === "thread") throw bad("A thread stays under its room.");
			if (room.key === this.#options.home())
				throw bad("Home stays at the top.");
			const body = await bodyOf(request);
			const before = beforeOf(body);
			if (action === "pin") {
				const { pinned } = body;
				if (typeof pinned !== "boolean")
					throw bad("pinned must be true or false.");
				return json(
					await this.#write((layout) =>
						setPinned(layout, room.key, pinned, before),
					),
				);
			}
			const { folder } = body;
			if (folder !== null && typeof folder !== "string")
				throw bad("folder must be a folder id or null.");
			return json(
				await this.#write((layout) =>
					placeRoom(layout, room.key, folder, before),
				),
			);
		});
	}

	/** Stores an edit, tells the other pages, and answers with the layout as readers see it. */
	async #write(edit: (layout: LayoutView) => LayoutView): Promise<LayoutView> {
		const stored = await this.#options.layout.change(edit);
		this.#options.changed();
		const rooms = this.#options.placeable();
		return shown(stored, (key) => rooms.has(key));
	}

	async #guard(run: () => Promise<Response>): Promise<Response> {
		try {
			return await run();
		} catch (error) {
			const refusal = error instanceof LayoutError ? refusalOf(error) : error;
			if (refusal instanceof LayoutRefusal)
				return json(
					{ error: refusal.message } satisfies ApiError,
					refusal.status,
				);
			throw error;
		}
	}
}

const notAllowed = "Method not allowed.";
const notAnApi = "There is no such API.";
