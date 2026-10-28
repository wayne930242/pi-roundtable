import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type { RoomFile, RoomMessage } from "../api-types.ts";

/** A message to store; the log numbers it and stamps its time. */
export interface NewRoomMessage {
	room: string;
	kind: RoomMessage["kind"];
	principalId?: string;
	agent?: string;
	author: string;
	text: string;
	files?: RoomFile[];
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
}

/** The most messages one page of history holds. */
export const PAGE_LIMIT = 100;

function messageOf(row: Row): RoomMessage {
	const files =
		typeof row.files === "string"
			? (JSON.parse(row.files) as RoomFile[])
			: row.files;
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

	async append(message: NewRoomMessage): Promise<RoomMessage> {
		const files = JSON.stringify(message.files ?? []);
		const [row]: Row[] = await this.#sql`
			INSERT INTO web_room_messages (room, kind, principal_id, agent, author_name, text, files)
			VALUES (${message.room}, ${message.kind}, ${message.principalId ?? null},
				${message.agent ?? null}, ${message.author}, ${message.text}, ${files}::jsonb)
			RETURNING *`;
		if (!row) throw new Error("the room log stored nothing");
		return messageOf(row);
	}

	/** Changes the text of a stored message; undefined when there is no such message. */
	async edit(id: number, text: string): Promise<RoomMessage | undefined> {
		const [row]: Row[] = await this.#sql`
			UPDATE web_room_messages SET text = ${text} WHERE id = ${id} RETURNING *`;
		return row && messageOf(row);
	}

	/** The newest `limit` messages older than `before` (all of them when absent), oldest first. */
	async page(
		room: string,
		before: number | undefined,
		limit: number,
	): Promise<{ messages: RoomMessage[]; more: boolean }> {
		const count = Math.min(Math.max(Math.trunc(limit), 1), PAGE_LIMIT);
		const rows: Row[] =
			before === undefined
				? await this.#sql`
					SELECT * FROM web_room_messages WHERE room = ${room}
					ORDER BY id DESC LIMIT ${count + 1}`
				: await this.#sql`
					SELECT * FROM web_room_messages WHERE room = ${room} AND id < ${before}
					ORDER BY id DESC LIMIT ${count + 1}`;
		return {
			messages: rows.slice(0, count).map(messageOf).reverse(),
			more: rows.length > count,
		};
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
