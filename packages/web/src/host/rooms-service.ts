import type { ChannelKey, Logger } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import type { ServerFrame } from "../api-types.ts";
import { MAX_MESSAGE_CHARS } from "../api-types.ts";
import { type FileDir, isFileId, safeName } from "../app/files.ts";
import type { RoomLog } from "../app/room-log.ts";
import { viewerOfSocket } from "../app/socket.ts";
import type { AppSocket, Sockets } from "../app/sockets.ts";
import { imageTypeOf } from "../app/uploads.ts";
import type {
	HostCard,
	HostRoomKind,
	HostRooms,
	WebAppRegistry,
} from "../web-app.ts";
import type { HostAccess } from "./access.ts";
import type { HostCardLog } from "./cards.ts";
import { checkCard } from "./forms.ts";
import { cardView, checkPicture, type FoundRoom } from "./room-views.ts";

/** The most files one post carries. */
const MAX_POST_FILES = 20;
const AUTHOR_KINDS = new Set(["external", "member", "assistant", "notice"]);
const DAY_MS = 86_400_000;

export interface HostRoomsOptions {
	registry: Pick<WebAppRegistry, "hostKindOf" | "kinds">;
	sockets: Pick<Sockets, "each" | "deliver" | "reaches">;
	log: Pick<RoomLog, "appendOnce" | "edit" | "remove" | "byReference" | "get">;
	cards: Pick<HostCardLog, "create" | "update" | "get">;
	/** The stored files, where `saveFile` keeps what a host saves. */
	files: FileDir;
	access: Pick<HostAccess, "forget" | "of">;
	/** The most bytes of one saved file. */
	maxFileBytes: number;
	/** The same-origin URL of a room, and of one of its messages. */
	roomUrl(room: ChannelKey, message?: number): string;
	/** Which kinds a person's last list showed, so the list's changes reach only them. */
	listed: ListedKinds;
	now?: () => number;
	logger: Logger;
}

/** What each person's latest `list` of each kind answered: whether it was defined for them. */
export class ListedKinds {
	readonly #by = new Map<string, Set<string>>();

	set(principalId: string, kind: string, defined: boolean): void {
		const kinds = this.#by.get(principalId) ?? new Set<string>();
		if (defined) kinds.add(kind);
		else kinds.delete(kind);
		this.#by.set(principalId, kinds);
	}

	has(principalId: string, kind: string): boolean {
		return this.#by.get(principalId)?.has(kind) ?? false;
	}
}

/** Collects a file's bytes, refusing more than `max`. */
async function bytesOf(
	source: Uint8Array | ReadableStream,
	max: number,
): Promise<Uint8Array> {
	if (source instanceof Uint8Array) {
		if (source.byteLength > max)
			throw new PluginError(`web app: a saved file is at most ${max} bytes`);
		return source;
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = source.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = value as Uint8Array;
		size += chunk.byteLength;
		if (size > max) {
			await reader.cancel();
			throw new PluginError(`web app: a saved file is at most ${max} bytes`);
		}
		chunks.push(chunk);
	}
	const whole = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		whole.set(chunk, at);
		at += chunk.byteLength;
	}
	return whole;
}

/**
 * What the app's stored file keeps as the type of a host's file: an image type only when the bytes
 * are that image (the page shows those inline), anything else the host declared as given.
 */
export function keptType(declared: string, bytes: Uint8Array): string {
	const image = imageTypeOf(bytes.subarray(0, 16));
	if (image) return image;
	return declared.startsWith("image/") ? "application/octet-stream" : declared;
}

/** The PNG, JPEG or WebP the bytes are, if they are one: the images host Markdown may show. */
export function markdownImageType(bytes: Uint8Array): string | undefined {
	const type = imageTypeOf(bytes.subarray(0, 16));
	return type === "image/gif" ? undefined : type;
}

/**
 * What a host writes into its rooms (`WebApp.rooms`): messages, their edits and removals, cards,
 * and the files they carry. Everything the host passes is checked here, because it comes from
 * a plugin, not from a person; what is stored is then shown, at once, to the sockets that follow
 * the room and may read it now.
 */
export class HostRoomsService implements HostRooms {
	readonly #options: HostRoomsOptions;
	/** One delivery at a time per room, so frames of quick changes arrive in the order they were made. */
	readonly #chains = new Map<string, Promise<void>>();

	constructor(options: HostRoomsOptions) {
		this.#options = options;
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	#found(room: string): FoundRoom {
		const found = this.#options.registry.hostKindOf(room);
		if (!found)
			throw new PluginError(
				`web app: ${JSON.stringify(room)} is not a room of a registered kind`,
			);
		return found;
	}

	/** When a file saved in a room of this kind goes, counted from `from`; undefined when the kind keeps files. */
	expiryOf(kind: HostRoomKind, from: number): number | undefined {
		return kind.retention ? from + kind.retention.fileDays * DAY_MS : undefined;
	}

	// ── Messages ──

	async post(
		room: ChannelKey,
		m: Parameters<HostRooms["post"]>[1],
	): Promise<{ id: number }> {
		const { kind } = this.#found(room);
		const { author } = m;
		if (!AUTHOR_KINDS.has(author.kind))
			throw new PluginError(
				"web app: a message's author is external, member, assistant or notice",
			);
		if (
			typeof author.name !== "string" ||
			author.name.trim() === "" ||
			author.name.length > 120
		)
			throw new PluginError(
				"web app: an author needs a name of at most 120 characters",
			);
		if (
			author.label !== undefined &&
			(typeof author.label !== "string" || author.label.length > 40)
		)
			throw new PluginError(
				"web app: an author's label is at most 40 characters",
			);
		const picture = author.picture ? checkPicture(author.picture) : undefined;
		const text = m.text ?? "";
		if (typeof text !== "string" || text.length > MAX_MESSAGE_CHARS)
			throw new PluginError(
				`web app: a message's text is at most ${MAX_MESSAGE_CHARS} characters`,
			);
		const ids = m.files ?? [];
		if (ids.length > MAX_POST_FILES || new Set(ids).size !== ids.length)
			throw new PluginError(
				`web app: a message carries at most ${MAX_POST_FILES} different files`,
			);
		if (text === "" && ids.length === 0)
			throw new PluginError("web app: a message needs text or a file");
		if (
			m.reference !== undefined &&
			(typeof m.reference !== "string" ||
				m.reference === "" ||
				m.reference.length > 300)
		)
			throw new PluginError("web app: a reference is 1 to 300 characters");
		const files = ids.map((id) => {
			const meta = this.#options.files.meta(id);
			if (
				!isFileId(id) ||
				!meta ||
				this.#options.files.binding(id)?.room !== room
			)
				throw new PluginError(
					`web app: file ${id} was not saved in ${room}; save it with rooms.saveFile for this room`,
				);
			return meta;
		});
		const now = this.#now();
		const at =
			m.at && !Number.isNaN(m.at.getTime())
				? new Date(Math.min(m.at.getTime(), now))
				: undefined;
		const stored = await this.#options.log.appendOnce({
			room,
			// A person's words are `owner` lines, the assistant's an `agent`'s, a notice a `system` line.
			kind:
				author.kind === "assistant"
					? "agent"
					: author.kind === "notice"
						? "system"
						: "owner",
			...(author.principalId ? { principalId: author.principalId } : {}),
			author: author.name.trim(),
			text,
			files,
			authorKind: author.kind,
			...(author.label ? { authorLabel: author.label } : {}),
			...(picture ? { picture } : {}),
			...(m.reference ? { reference: m.reference } : {}),
			...(at ? { at } : {}),
		});
		if (!stored.created) return { id: stored.message.id };
		// A file lives as long as the kind keeps files, counted from when the message was written.
		if (at)
			for (const file of files)
				this.#options.files.bind(file.id, {
					room,
					...(this.expiryOf(kind, at.getTime()) === undefined
						? {}
						: { expiresAt: this.expiryOf(kind, at.getTime()) as number }),
				});
		this.#deliver(room, {
			type: "host_message",
			room,
			message: stored.message,
		});
		this.#listChanged(kind.kind);
		return { id: stored.message.id };
	}

	async edit(room: ChannelKey, id: number, text: string): Promise<void> {
		this.#found(room);
		if (typeof text !== "string" || text.length > MAX_MESSAGE_CHARS)
			throw new PluginError(
				`web app: a message's text is at most ${MAX_MESSAGE_CHARS} characters`,
			);
		const message = await this.#options.log.edit(room, id, text, true);
		if (!message)
			throw new PluginError(`web app: ${room} has no message ${id}`);
		this.#deliver(room, { type: "host_edited", room, message });
	}

	async remove(room: ChannelKey, id: number): Promise<void> {
		const { kind } = this.#found(room);
		const row = await this.#options.log.remove(room, id);
		if (!row) return;
		for (const file of row.files)
			if (this.#options.files.binding(file.id)?.room === room)
				this.#options.files.remove(file.id);
		this.#deliver(room, { type: "host_removed", room, id });
		this.#listChanged(kind.kind);
	}

	byReference(
		room: ChannelKey,
		reference: string,
	): Promise<number | undefined> {
		this.#found(room);
		return this.#options.log.byReference(room, reference);
	}

	// ── Cards ──

	async card(room: ChannelKey, card: HostCard): Promise<{ id: string }> {
		this.#found(room);
		checkCard(card);
		const stored = await this.#options.cards.create(room, card);
		this.#showCard(room, stored.id);
		return { id: stored.id };
	}

	async updateCard(
		room: ChannelKey,
		id: string,
		card: HostCard,
	): Promise<void> {
		this.#found(room);
		checkCard(card);
		const stored = await this.#options.cards.update(room, id, card);
		if (!stored) throw new PluginError(`web app: ${room} has no card ${id}`);
		this.#showCard(room, id);
	}

	/** Shows a card to the room's readers, each its own buttons. */
	#showCard(room: ChannelKey, id: string): void {
		const found = this.#found(room);
		this.#chain(room, async () => {
			const stored = await this.#options.cards.get(room, id);
			if (!stored) return;
			const targets: AppSocket[] = [];
			this.#options.sockets.each(
				(connection) => this.#options.sockets.reaches(connection, { room }),
				(connection) => targets.push(connection),
			);
			for (const connection of targets) {
				const viewer = viewerOfSocket(connection);
				const access = await this.#options.access.of(viewer, room);
				if (!access) continue;
				this.#options.sockets.deliver(
					{
						type: "host_card",
						room,
						card: await cardView(viewer, found, access, stored),
					},
					{ connection, audience: { room } },
				);
			}
		});
	}

	// ── Files ──

	async saveFile(
		room: ChannelKey,
		file: { name: string; type: string; bytes: Uint8Array | ReadableStream },
	): Promise<string> {
		const { kind } = this.#found(room);
		if (typeof file.type !== "string" || file.type === "")
			throw new PluginError("web app: a saved file needs a type");
		const bytes = await bytesOf(file.bytes, this.#options.maxFileBytes);
		if (bytes.byteLength === 0)
			throw new PluginError("web app: a saved file is not empty");
		const expiresAt = this.expiryOf(kind, this.#now());
		return this.#options.files.put(
			safeName(file.name),
			keptType(file.type, bytes),
			bytes,
			undefined,
			{ room, ...(expiresAt === undefined ? {} : { expiresAt }) },
		).id;
	}

	// ── What changed ──

	link(room: ChannelKey, message?: number): string {
		this.#found(room);
		if (message !== undefined && !Number.isSafeInteger(message))
			throw new PluginError("web app: a message number is a whole number");
		return this.#options.roomUrl(room, message);
	}

	changed(room?: ChannelKey): void {
		if (room === undefined) {
			for (const kind of this.#options.registry.kinds())
				this.#listChanged(kind.kind);
			this.#options.access.forget({}).catch(() => undefined);
			return;
		}
		const { kind } = this.#found(room);
		// The followers are asked again first, so only those who still read the room are told to look again.
		this.#chain(room, async () => {
			await this.#options.access.forget({ room });
			this.#deliver(room, { type: "room_changed", room }, false);
		});
		this.#listChanged(kind.kind);
	}

	accessChanged(principalId?: string): void {
		this.#options.access
			.forget(principalId === undefined ? {} : { principalId })
			.catch(() => undefined);
		// Their lists may differ now.
		for (const kind of this.#options.registry.kinds())
			this.#listChanged(kind.kind);
	}

	/** Tells those whose list of a kind was defined that it may differ; the frame holds nothing. */
	#listChanged(kind: string): void {
		const { sockets, listed } = this.#options;
		sockets.each(
			(connection) => listed.has(connection.principal.id, kind),
			(connection) =>
				sockets.deliver({ type: "list_changed", kind }, { connection }),
		);
	}

	/** Puts a frame of a room on the sockets that follow it and may read it now, in order after earlier ones. */
	#deliver(room: string, frame: ServerFrame, queued = true): void {
		const send = async () => {
			this.#options.sockets.deliver(frame, { room });
		};
		if (queued) this.#chain(room, send);
		else send().catch(() => undefined);
	}

	#chain(room: string, step: () => Promise<void>): void {
		const previous = this.#chains.get(room) ?? Promise.resolve();
		const next = previous
			.then(step)
			.catch((error: unknown) =>
				this.#options.logger.warn(
					{ room, err: error },
					"a host room frame was not delivered",
				),
			);
		this.#chains.set(room, next);
		void next.then(() => {
			if (this.#chains.get(room) === next) this.#chains.delete(room);
		});
	}
}
