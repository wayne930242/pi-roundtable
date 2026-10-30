import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type { HostCard, StoredHostCard } from "../web-app.ts";
import { storedJson } from "./stored-json.ts";

interface Row {
	id: string;
	room: string;
	card: HostCard | string;
	created_at: Date;
	updated_at: Date;
}

function cardOf(row: Row): StoredHostCard {
	return {
		...storedJson(row.card, "host card"),
		id: row.id,
		room: row.room as StoredHostCard["room"],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * The cards hosts put in their rooms, kept in `web_host_cards`: a title and body, a state, links
 * and buttons, which the host updates in place as the thing the card stands for moves on. Held-call
 * approvals and questions are not here; they are the desk's cards.
 */
export class HostCardLog {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-host-cards",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_host_cards (
					id text PRIMARY KEY,
					room text NOT NULL,
					card jsonb NOT NULL,
					state text,
					created_at timestamptz NOT NULL DEFAULT now(),
					updated_at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`CREATE INDEX IF NOT EXISTS web_host_cards_room_created ON web_host_cards (room, created_at)`;
		},
	};

	/** The mark of a card the host keeps past its kind's retention (`HostCard.keep`). */
	static readonly keepMigration: Migration = {
		name: "web-host-cards-keep",
		up: async (sql) => {
			await sql`
				ALTER TABLE web_host_cards ADD COLUMN IF NOT EXISTS keep boolean NOT NULL DEFAULT false`;
		},
	};

	async create(room: string, card: HostCard): Promise<StoredHostCard> {
		const id = crypto.randomUUID();
		const [row]: Row[] = await this.#sql`
			INSERT INTO web_host_cards (id, room, card, state, keep)
			VALUES (${id}, ${room}, ${JSON.stringify(card)}::jsonb, ${card.state ?? null}, ${card.keep === true})
			RETURNING *`;
		if (!row) throw new Error("the card log stored nothing");
		return cardOf(row);
	}

	/** Replaces a card of the room; undefined when the room holds no such card. */
	async update(
		room: string,
		id: string,
		card: HostCard,
	): Promise<StoredHostCard | undefined> {
		const [row]: Row[] = await this.#sql`
			UPDATE web_host_cards
			SET card = ${JSON.stringify(card)}::jsonb, state = ${card.state ?? null}, keep = ${card.keep === true}, updated_at = now()
			WHERE id = ${id} AND room = ${room} RETURNING *`;
		return row && cardOf(row);
	}

	async get(room: string, id: string): Promise<StoredHostCard | undefined> {
		const [row]: Row[] = await this.#sql`
			SELECT * FROM web_host_cards WHERE id = ${id} AND room = ${room}`;
		return row && cardOf(row);
	}

	/** The room's cards, oldest first. */
	async list(room: string): Promise<StoredHostCard[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM web_host_cards WHERE room = ${room} ORDER BY created_at, id`;
		return rows.map(cardOf);
	}

	/**
	 * Deletes the cards of the rooms whose key starts with `prefix` that are older than `before`,
	 * except those the host marked `keep`; how many.
	 */
	async sweepKind(prefix: string, before: Date): Promise<number> {
		const rows: unknown[] = await this.#sql`
			DELETE FROM web_host_cards
			WHERE starts_with(room, ${prefix}) AND created_at < ${before}
			AND NOT keep RETURNING 1`;
		return rows.length;
	}

	async removeRoom(room: string): Promise<void> {
		await this.#sql`DELETE FROM web_host_cards WHERE room = ${room}`;
	}
}
