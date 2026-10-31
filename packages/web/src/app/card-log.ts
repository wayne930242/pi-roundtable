import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type {
	CardAnswer,
	ClosedCard,
	PromptFrame,
	PromptOutcome,
} from "../api-types.ts";
import { jsonValuesMigration } from "../host/stored-json.ts";

interface Row {
	room: string;
	frame: PromptFrame | string;
	outcome: PromptOutcome;
	note: string | null;
	answered_by: string | null;
	answer: CardAnswer | string | null;
	closed_at: Date;
}

/** A jsonb column as the driver hands it back: parsed, or as text. */
function parsed<T>(value: T | string): T {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error("the card log holds JSON that cannot be read", {
			cause: error,
		});
	}
}

function cardOf(row: Row): ClosedCard {
	return {
		room: row.room,
		frame: parsed(row.frame),
		outcome: row.outcome,
		...(row.note === null ? {} : { note: row.note }),
		...(row.answered_by === null ? {} : { by: row.answered_by }),
		...(row.answer === null ? {} : { answer: parsed(row.answer) }),
		closedAt: row.closed_at.toISOString(),
	};
}

/**
 * The cards of the app's rooms that ended, kept in `web_room_cards` so a room's history shows
 * them after a reload as the Discord channel keeps a card with its answer. A row holds the card
 * as it was shown, so it carries nothing the card did not, and is written once, when the card
 * ends; the cards still open live in the desk.
 */
export class CardLog {
	readonly #sql: SQL;
	/** The writes under way, which a read waits for so a card that just ended is in it. */
	readonly #writing = new Set<Promise<void>>();

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** Its jsonb columns stored as the JSON values themselves, not as the text of them. */
	static readonly jsonValuesMigration: Migration = jsonValuesMigration(
		"web-room-cards-json-values",
		"web_room_cards",
		["frame", "answer"],
	);

	/** The log's table. */
	static readonly migration: Migration = {
		name: "web-room-cards",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_room_cards (
					prompt_id text PRIMARY KEY,
					room text NOT NULL,
					opened_at timestamptz NOT NULL,
					closed_at timestamptz NOT NULL,
					outcome text NOT NULL,
					note text,
					answered_by text,
					frame jsonb NOT NULL,
					answer jsonb
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_room_cards_room_opened ON web_room_cards (room, opened_at)`;
		},
	};

	/** Stores an ended card; a card stored already stays as it was. */
	record(card: ClosedCard): Promise<void> {
		const write = this.#write(card).finally(() => this.#writing.delete(write));
		this.#writing.add(write);
		return write;
	}

	async #write(card: ClosedCard): Promise<void> {
		const opened = card.frame.at ?? card.closedAt;
		await this.#sql`
			INSERT INTO web_room_cards
				(prompt_id, room, opened_at, closed_at, outcome, note, answered_by, frame, answer)
			VALUES (${card.frame.id}, ${card.room}, ${opened}::timestamptz, ${card.closedAt}::timestamptz,
				${card.outcome}, ${card.note ?? null}, ${card.by ?? null},
				${JSON.stringify(card.frame)}::text::jsonb,
				${card.answer ? JSON.stringify(card.answer) : null}::text::jsonb)
			ON CONFLICT (prompt_id) DO NOTHING`;
	}

	/** Deletes every ended card of a room that is gone for good, once the writes under way are in. */
	async removeRoom(room: string): Promise<void> {
		await Promise.allSettled([...this.#writing]);
		await this.#sql`DELETE FROM web_room_cards WHERE room = ${room}`;
	}

	/**
	 * The room's cards that opened at or after `from` (all of them when absent) and before the
	 * stored message `before` of the same room was written (all of them when absent), oldest
	 * first. Times compare at the millisecond, which is how the page orders them.
	 */
	async during(
		room: string,
		span: { from?: string; before?: number },
	): Promise<ClosedCard[]> {
		const { from, before } = span;
		await Promise.allSettled([...this.#writing]);
		const rows: Row[] = await this.#sql`
			SELECT room, frame, outcome, note, answered_by, answer, closed_at FROM web_room_cards
			WHERE room = ${room}
				AND (${from ?? null}::timestamptz IS NULL OR opened_at >= ${from ?? null}::timestamptz)
				AND (${before ?? null}::bigint IS NULL OR opened_at < (
					SELECT date_trunc('milliseconds', created_at) FROM web_room_messages
					WHERE id = ${before ?? null}::bigint AND room = ${room}))
			ORDER BY opened_at, closed_at`;
		return rows.map(cardOf);
	}
}
