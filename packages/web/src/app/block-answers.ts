import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type { BlockFields, RoomBlockAnswer } from "../api-types.ts";
import { storedJson } from "../host/stored-json.ts";

interface Row {
	message_id: string | number | bigint;
	block: number;
	fields: BlockFields | string;
}

/**
 * The interactive blocks of the app's agent replies that the owner has answered, kept in
 * `web_room_block_answers`: one row per block of a message, so a block takes one answer. The row
 * is written before the answer is sent and deleted when sending fails or the answer is cancelled
 * while it waits, which reopens the block. It goes with its message.
 */
export class BlockAnswers {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The table of answers. */
	static readonly migration: Migration = {
		name: "web-room-block-answers",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_room_block_answers (
					room text NOT NULL,
					message_id bigint NOT NULL REFERENCES web_room_messages (id) ON DELETE CASCADE,
					block integer NOT NULL,
					fields jsonb NOT NULL,
					answered_by text NOT NULL,
					answered_at timestamptz NOT NULL DEFAULT now(),
					answer_message_id bigint,
					UNIQUE (room, message_id, block)
				)`;
			// The cascade from a deleted message looks its rows up by message id, which the unique key (led by room) does not serve.
			await sql`CREATE INDEX IF NOT EXISTS web_room_block_answers_message ON web_room_block_answers (message_id)`;
			await sql`CREATE INDEX IF NOT EXISTS web_room_block_answers_answer ON web_room_block_answers (room, answer_message_id) WHERE answer_message_id IS NOT NULL`;
		},
	};

	/**
	 * Takes a block for an answer: `created` when no one had, else the fields of the answer that
	 * did. Two taps or two devices meet the unique row, so only one goes on to send.
	 */
	async take(
		room: string,
		message: number,
		block: number,
		fields: BlockFields,
		by: string,
	): Promise<{ created: true } | { created: false; fields: BlockFields }> {
		const rows: unknown[] = await this.#sql`
			INSERT INTO web_room_block_answers (room, message_id, block, fields, answered_by)
			VALUES (${room}, ${message}, ${block}, ${JSON.stringify(fields)}::text::jsonb, ${by})
			ON CONFLICT (room, message_id, block) DO NOTHING
			RETURNING 1`;
		if (rows.length > 0) return { created: true };
		const [row]: { fields: BlockFields | string }[] = await this.#sql`
			SELECT fields FROM web_room_block_answers
			WHERE room = ${room} AND message_id = ${message} AND block = ${block}`;
		// The earlier answer may have been given up between the two statements; the block is then taken again.
		if (!row) return this.take(room, message, block, fields, by);
		return {
			created: false,
			fields: storedJson(row.fields, "block answer"),
		};
	}

	/** Names the owner message that carried the answer, so cancelling that message can reopen the block. */
	async link(
		room: string,
		message: number,
		block: number,
		answerMessage: number,
	): Promise<void> {
		await this.#sql`
			UPDATE web_room_block_answers SET answer_message_id = ${answerMessage}
			WHERE room = ${room} AND message_id = ${message} AND block = ${block}`;
	}

	/** Gives the block up, so it takes an answer again. */
	async release(room: string, message: number, block: number): Promise<void> {
		await this.#sql`
			DELETE FROM web_room_block_answers
			WHERE room = ${room} AND message_id = ${message} AND block = ${block}`;
	}

	/** Gives up the block that the owner message `answerMessage` answered; the message it is in, or undefined when it answered none. */
	async releaseFor(
		room: string,
		answerMessage: number,
	): Promise<number | undefined> {
		const [row]: { message_id: string | number | bigint }[] = await this.#sql`
			DELETE FROM web_room_block_answers
			WHERE room = ${room} AND answer_message_id = ${answerMessage}
			RETURNING message_id`;
		return row === undefined ? undefined : Number(row.message_id);
	}

	/** Which of the owner messages `answerMessages` carry the answer to a block. */
	async carriedBy(
		room: string,
		answerMessages: readonly number[],
	): Promise<Set<number>> {
		if (answerMessages.length === 0) return new Set();
		const rows: { answer_message_id: string | number | bigint }[] = await this
			.#sql`
			SELECT answer_message_id FROM web_room_block_answers
			WHERE room = ${room} AND answer_message_id IN ${this.#sql(answerMessages)}`;
		return new Set(rows.map((row) => Number(row.answer_message_id)));
	}

	/** The answers of the given messages of a room, by message id; a message with none is absent. */
	async of(
		room: string,
		messages: readonly number[],
	): Promise<Map<number, RoomBlockAnswer[]>> {
		const found = new Map<number, RoomBlockAnswer[]>();
		if (messages.length === 0) return found;
		const rows: Row[] = await this.#sql`
			SELECT message_id, block, fields FROM web_room_block_answers
			WHERE room = ${room} AND message_id IN ${this.#sql(messages)}
			ORDER BY message_id, block`;
		for (const row of rows) {
			const id = Number(row.message_id);
			const list = found.get(id) ?? [];
			list.push({
				block: row.block,
				fields: storedJson(row.fields, "block answer"),
			});
			found.set(id, list);
		}
		return found;
	}
}
