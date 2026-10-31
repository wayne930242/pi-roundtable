import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import {
	type HostAuthorKind,
	type PictureRef,
	type RoomFile,
	type RoomIntercom,
	type RoomMessage,
	START_OVER_TEXT,
} from "../api-types.ts";
import { jsonValuesMigration, storedJson } from "../host/stored-json.ts";

/** A message to store; the log numbers it and stamps its time. */
export interface NewRoomMessage {
	room: string;
	kind: RoomMessage["kind"];
	principalId?: string;
	agent?: string;
	author: string;
	text: string;
	files?: RoomFile[];
	/** Host rooms: who wrote it, as the host's kinds of author name them. */
	authorKind?: HostAuthorKind;
	authorLabel?: string;
	picture?: PictureRef;
	/** Host rooms: the host's own id for the message, unique within the room. */
	reference?: string;
	/** When it was written, for an import; the log's clock otherwise. Retention counts from it. */
	at?: Date;
	/** An internal note: shown to the room's readers, never handed to the agent. */
	note?: true;
	/** A message between agents, drawn as a small card. */
	intercom?: RoomIntercom;
}

interface Row {
	id: string | number | bigint;
	room: string;
	kind: RoomMessage["kind"];
	principal_id: string | null;
	agent: string | null;
	author_name: string;
	text: string;
	files: RoomFile[] | string;
	created_at: Date;
	author_kind: HostAuthorKind | null;
	author_label: string | null;
	picture: PictureRef | string | null;
	edited_at: Date | null;
	note: boolean | null;
	intercom?: RoomIntercom | string | null;
}

/** The most messages one page of history holds. */
export const PAGE_LIMIT = 100;

function messageOf(row: Row): RoomMessage {
	const files = storedJson(row.files, "message files");
	return {
		id: Number(row.id),
		room: row.room,
		kind: row.kind,
		...(row.principal_id === null ? {} : { principalId: row.principal_id }),
		...(row.agent === null ? {} : { agent: row.agent }),
		author: row.author_name,
		text: row.text,
		files,
		at: row.created_at.toISOString(),
		...(row.author_kind === null ? {} : { authorKind: row.author_kind }),
		...(row.author_label === null ? {} : { authorLabel: row.author_label }),
		...(row.picture === null
			? {}
			: {
					picture: storedJson(row.picture, "picture"),
				}),
		...(row.edited_at === null ? {} : { edited: true as const }),
		...(row.note ? { note: true as const } : {}),
		...(row.intercom == null
			? {}
			: { intercom: storedJson(row.intercom, "intercom card") }),
	};
}

/**
 * The app's rooms' messages, kept in `web_room_messages`: what the owner wrote, what the agents
 * answered, and the lines the server wrote, such as a conversation's start-over divider. Rooms
 * are separate from the Discord channels' history, which the conversations pane reads as
 * transcripts.
 */
export class RoomLog {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** Its jsonb columns stored as the JSON values themselves, not as the text of them. */
	static readonly jsonValuesMigration: Migration = jsonValuesMigration(
		"web-room-messages-json-values",
		"web_room_messages",
		["files", "picture", "intercom"],
	);

	/** The log's table. */
	static readonly migration: Migration = {
		name: "web-room-messages",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_room_messages (
					id bigserial PRIMARY KEY,
					room text NOT NULL,
					kind text NOT NULL,
					principal_id text,
					agent text,
					author_name text NOT NULL,
					text text NOT NULL,
					files jsonb NOT NULL DEFAULT '[]',
					created_at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_room_messages_room_id ON web_room_messages (room, id)`;
		},
	};

	/** The columns a host room's messages add: who wrote it, the host's reference, and when it was changed. */
	static readonly hostMigration: Migration = {
		name: "web-room-messages-host",
		up: async (sql) => {
			await sql`ALTER TABLE web_room_messages ADD COLUMN IF NOT EXISTS author_kind text`;
			await sql`ALTER TABLE web_room_messages ADD COLUMN IF NOT EXISTS author_label text`;
			await sql`ALTER TABLE web_room_messages ADD COLUMN IF NOT EXISTS picture jsonb`;
			await sql`ALTER TABLE web_room_messages ADD COLUMN IF NOT EXISTS reference text`;
			await sql`ALTER TABLE web_room_messages ADD COLUMN IF NOT EXISTS edited_at timestamptz`;
			await sql`CREATE UNIQUE INDEX IF NOT EXISTS web_room_messages_reference ON web_room_messages (room, reference) WHERE reference IS NOT NULL`;
			await sql`CREATE INDEX IF NOT EXISTS web_room_messages_created ON web_room_messages (created_at)`;
		},
	};

	/** The column that marks a message as an internal note, for the rooms more than one person reads. */
	static readonly noteMigration: Migration = {
		name: "web-room-messages-note",
		up: async (sql) => {
			await sql`ALTER TABLE web_room_messages ADD COLUMN IF NOT EXISTS note boolean NOT NULL DEFAULT false`;
		},
	};

	/** The column that marks a message between agents, with which way it went and the other agent. */
	static readonly intercomMigration: Migration = {
		name: "web-room-messages-intercom",
		up: async (sql) => {
			await sql`ALTER TABLE web_room_messages ADD COLUMN IF NOT EXISTS intercom jsonb`;
		},
	};

	/** Finds a room's start-over lines without reading the whole room. */
	static readonly startOverMigration: Migration = {
		name: "web-room-messages-start-over",
		up: async (sql) => {
			await sql`CREATE INDEX IF NOT EXISTS web_room_messages_start_over ON web_room_messages (room, id) WHERE kind = 'system' AND text = 'Conversation started over'`;
		},
	};

	async append(message: NewRoomMessage): Promise<RoomMessage> {
		const [row] = await this.#insert(message, false);
		if (!row) throw new Error("the room log stored nothing");
		return messageOf(row);
	}

	/**
	 * Stores a host room's message once per `reference`: a second post with the same reference in
	 * the room stores nothing and answers the message already there, with `created` false.
	 */
	async appendOnce(
		message: NewRoomMessage,
	): Promise<{ message: RoomMessage; created: boolean }> {
		const [row] = await this.#insert(message, message.reference !== undefined);
		if (row) return { message: messageOf(row), created: true };
		const [existing]: Row[] = await this.#sql`
			SELECT * FROM web_room_messages
			WHERE room = ${message.room} AND reference = ${message.reference ?? null}`;
		if (!existing) throw new Error("the room log stored nothing");
		return { message: messageOf(existing), created: false };
	}

	async #insert(message: NewRoomMessage, once: boolean): Promise<Row[]> {
		const files = JSON.stringify(message.files ?? []);
		const picture = message.picture ? JSON.stringify(message.picture) : null;
		const intercom = message.intercom ? JSON.stringify(message.intercom) : null;
		const at = message.at ?? new Date();
		return once
			? await this.#sql`
				INSERT INTO web_room_messages (room, kind, principal_id, agent, author_name, text, files,
					author_kind, author_label, picture, reference, created_at, note, intercom)
				VALUES (${message.room}, ${message.kind}, ${message.principalId ?? null},
					${message.agent ?? null}, ${message.author}, ${message.text}, ${files}::text::jsonb,
					${message.authorKind ?? null}, ${message.authorLabel ?? null}, ${picture}::text::jsonb,
					${message.reference ?? null}, ${at}, ${message.note === true}, ${intercom}::text::jsonb)
				ON CONFLICT (room, reference) WHERE reference IS NOT NULL DO NOTHING
				RETURNING *`
			: await this.#sql`
				INSERT INTO web_room_messages (room, kind, principal_id, agent, author_name, text, files,
					author_kind, author_label, picture, reference, created_at, note, intercom)
				VALUES (${message.room}, ${message.kind}, ${message.principalId ?? null},
					${message.agent ?? null}, ${message.author}, ${message.text}, ${files}::text::jsonb,
					${message.authorKind ?? null}, ${message.authorLabel ?? null}, ${picture}::text::jsonb,
					${message.reference ?? null}, ${at}, ${message.note === true}, ${intercom}::text::jsonb)
				RETURNING *`;
	}

	/**
	 * Changes the text of a message stored in the room; undefined when the room holds no such
	 * message. `mark` shows it as edited, as a host's edit of someone's words does.
	 */
	async edit(
		room: string,
		id: number,
		text: string,
		mark = false,
	): Promise<RoomMessage | undefined> {
		const [row]: Row[] = mark
			? await this.#sql`
				UPDATE web_room_messages SET text = ${text}, edited_at = now()
				WHERE id = ${id} AND room = ${room} RETURNING *`
			: await this.#sql`
				UPDATE web_room_messages SET text = ${text}
				WHERE id = ${id} AND room = ${room} RETURNING *`;
		return row && messageOf(row);
	}

	/** The message the host's reference names, if the room holds one. */
	async byReference(
		room: string,
		reference: string,
	): Promise<number | undefined> {
		const [row]: { id: string | number | bigint }[] = await this.#sql`
			SELECT id FROM web_room_messages WHERE room = ${room} AND reference = ${reference}`;
		return row === undefined ? undefined : Number(row.id);
	}

	/** One stored message of the room, or undefined. */
	async get(room: string, id: number): Promise<RoomMessage | undefined> {
		const [row]: Row[] = await this.#sql`
			SELECT * FROM web_room_messages WHERE room = ${room} AND id = ${id}`;
		return row && messageOf(row);
	}

	/** Deletes one message of the room; the message as it was, or undefined when the room held none. */
	async remove(room: string, id: number): Promise<RoomMessage | undefined> {
		const [row]: Row[] = await this.#sql`
			DELETE FROM web_room_messages WHERE room = ${room} AND id = ${id} RETURNING *`;
		return row && messageOf(row);
	}

	/**
	 * Deletes the messages older than `before` of the rooms whose key starts with `prefix`, the
	 * kind's rooms; the deleted messages, so their files can go too. Age is the message's own time.
	 */
	async sweepKind(prefix: string, before: Date): Promise<RoomMessage[]> {
		const rows: Row[] = await this.#sql`
			DELETE FROM web_room_messages
			WHERE starts_with(room, ${prefix}) AND created_at < ${before} RETURNING *`;
		return rows.map(messageOf);
	}

	/** The newest message id of each room that has one, for the read cursors. */
	async newestIds(rooms: readonly string[]): Promise<Map<string, number>> {
		const found = new Map<string, number>();
		if (rooms.length === 0) return found;
		const rows: { room: string; id: string | number | bigint }[] = await this
			.#sql`
			SELECT room, max(id) AS id FROM web_room_messages
			WHERE room IN ${this.#sql(rooms)} GROUP BY room`;
		for (const row of rows) found.set(row.room, Number(row.id));
		return found;
	}

	/**
	 * The newest `limit` messages older than `before` (all of them when absent), oldest first, of
	 * the room's conversation: from its latest start-over line, which the page includes, on. With
	 * `until`, the id of one of its start-over lines, those of the conversation that line ended
	 * instead: older than the line, back to the start-over line before it.
	 */
	async page(
		room: string,
		before: number | undefined,
		limit: number,
		until?: number,
	): Promise<{ messages: RoomMessage[]; more: boolean }> {
		const count = Math.min(Math.max(Math.trunc(limit), 1), PAGE_LIMIT);
		const start = await this.startOver(room, until);
		// The live conversation includes its own start line; an archived one ends before the next.
		const above = until === undefined ? (start ?? 1) - 1 : (start ?? 0);
		const below =
			until === undefined
				? before
				: before === undefined
					? until
					: Math.min(before, until);
		const rows: Row[] = await this.#sql`
			SELECT * FROM web_room_messages
			WHERE room = ${room} AND id > ${above}
				AND (${below ?? null}::bigint IS NULL OR id < ${below ?? null}::bigint)
			ORDER BY id DESC LIMIT ${count + 1}`;
		return {
			messages: rows.slice(0, count).map(messageOf).reverse(),
			more: rows.length > count,
		};
	}

	/** The id of the room's latest start-over line, or of the latest one older than `before`. */
	async startOver(room: string, before?: number): Promise<number | undefined> {
		const [row]: { id: string | number | bigint | null }[] = await this.#sql`
			SELECT max(id) AS id FROM web_room_messages
			WHERE room = ${room} AND kind = 'system' AND text = ${START_OVER_TEXT}
				AND (${before ?? null}::bigint IS NULL OR id < ${before ?? null}::bigint)`;
		return row?.id === null || row?.id === undefined
			? undefined
			: Number(row.id);
	}

	/** Deletes every message of a room that is gone for good; returns how many. */
	async removeRoom(room: string): Promise<number> {
		const rows: unknown[] = await this
			.#sql`DELETE FROM web_room_messages WHERE room = ${room} RETURNING 1`;
		return rows.length;
	}

	/** The newest message of each of the rooms that has one. */
	async lastOf(rooms: readonly string[]): Promise<Map<string, RoomMessage>> {
		const found = new Map<string, RoomMessage>();
		if (rooms.length === 0) return found;
		const rows: Row[] = await this.#sql`
			SELECT DISTINCT ON (room) * FROM web_room_messages
			WHERE room IN ${this.#sql(rooms)}
			ORDER BY room, id DESC`;
		for (const row of rows) found.set(row.room, messageOf(row));
		return found;
	}
}
