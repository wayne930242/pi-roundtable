import type { SQL } from "bun";
import type { Migration } from "../../db/migrations.ts";
import { MemoryError } from "../../domain/errors.ts";

export const OWNER_MEMORY_KINDS = ["core", "note", "event"] as const;
export type OwnerMemoryKind = (typeof OWNER_MEMORY_KINDS)[number];

export interface OwnerMemory {
	id: number;
	kind: OwnerMemoryKind;
	fact: string;
	/** YYYY-MM-DD; set for events only. */
	eventDate: string | null;
}

/** What every owner turn carries: all core facts, and events that have not passed yet. */
export interface OwnerPromptMemory {
	core: OwnerMemory[];
	events: OwnerMemory[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_LIMIT = 20;

interface Row {
	id: string | number;
	kind: OwnerMemoryKind;
	fact: string;
	event_date: string | null;
}

function toMemory(row: Row): OwnerMemory {
	return {
		id: Number(row.id),
		kind: row.kind,
		fact: row.fact,
		eventDate: row.event_date,
	};
}

/** Whitespace-separated query terms, deduplicated; Chinese needs no tokenizer this way. */
export function searchTerms(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/\s+/)
				.filter((term) => term.length > 0),
		),
	];
}

/** The trimmed fact, after the rules every stored memory follows. */
function checkedFact(
	fact: string,
	kind: OwnerMemoryKind,
	eventDate: string | undefined,
): string {
	const trimmed = fact.trim();
	if (!trimmed) throw new MemoryError("a memory fact cannot be empty");
	if (!(OWNER_MEMORY_KINDS as readonly string[]).includes(kind))
		throw new MemoryError(`unknown memory kind: ${kind}`);
	if (kind === "event" && !(eventDate && DATE.test(eventDate)))
		throw new MemoryError("an event needs its date as YYYY-MM-DD");
	if (kind !== "event" && eventDate)
		throw new MemoryError("only an event has a date");
	return trimmed;
}

/**
 * One speaker's remembered facts in the database: core facts, searchable notes, and
 * dated events. The store is bound to a speaker and never reads or changes another's; every
 * agent shares the memory of whoever is speaking.
 */
export class OwnerMemoryStore {
	readonly #sql: SQL;
	/** Whose memory this is: a Discord user id. */
	readonly speakerId: string;

	private constructor(sql: SQL, speakerId: string) {
		this.#sql = sql;
		this.speakerId = speakerId;
	}

	/** Connects, and creates or upgrades the table; rows from before kinds existed become core facts. */
	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = {
		name: "owner-memory",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS owner_memory (
					id bigserial PRIMARY KEY,
					fact text NOT NULL CHECK (length(btrim(fact)) > 0),
					created_at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`
				ALTER TABLE owner_memory
					ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'core'
						CHECK (kind IN ('core', 'note', 'event')),
					ADD COLUMN IF NOT EXISTS event_date date,
					ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
		},
	};

	/**
	 * The store's table, then each fact's speaker, with the facts stored before speakers
	 * existed given to `ownerId`, whose they were.
	 */
	static migrations(ownerId: string): Migration[] {
		return [
			OwnerMemoryStore.migration,
			{
				name: "owner-memory-speaker",
				up: async (sql) => {
					await sql.begin(async (tx) => {
						await tx`SELECT pg_advisory_xact_lock(7284912302)`;
						await tx`ALTER TABLE owner_memory ADD COLUMN IF NOT EXISTS speaker_id text`;
						await tx`UPDATE owner_memory SET speaker_id = ${ownerId} WHERE speaker_id IS NULL`;
						await tx`ALTER TABLE owner_memory ALTER COLUMN speaker_id SET NOT NULL`;
						await tx`CREATE INDEX IF NOT EXISTS owner_memory_speaker ON owner_memory (speaker_id, id)`;
					});
				},
			},
		];
	}

	/** The store over the host's migrated pool, holding one speaker's memory. */
	static attach(sql: SQL, speakerId: string): OwnerMemoryStore {
		return new OwnerMemoryStore(sql, speakerId);
	}

	/** Another speaker's memory in the same database. */
	forSpeaker(speakerId: string): OwnerMemoryStore {
		return speakerId === this.speakerId
			? this
			: new OwnerMemoryStore(this.#sql, speakerId);
	}

	async list(): Promise<OwnerMemory[]> {
		const rows: Row[] = await this.#sql`
			SELECT id, kind, fact, to_char(event_date, 'YYYY-MM-DD') AS event_date
			FROM owner_memory WHERE speaker_id = ${this.speakerId} ORDER BY id`;
		return rows.map(toMemory);
	}

	async forPrompt(today: string): Promise<OwnerPromptMemory> {
		const rows: Row[] = await this.#sql`
			SELECT id, kind, fact, to_char(event_date, 'YYYY-MM-DD') AS event_date
			FROM owner_memory
			WHERE speaker_id = ${this.speakerId}
				AND (kind = 'core' OR (kind = 'event' AND event_date >= ${today}::date))
			ORDER BY event_date NULLS FIRST, id`;
		const memories = rows.map(toMemory);
		return {
			core: memories.filter((memory) => memory.kind === "core"),
			events: memories.filter((memory) => memory.kind === "event"),
		};
	}

	async add(
		fact: string,
		kind: OwnerMemoryKind = "core",
		eventDate?: string,
	): Promise<OwnerMemory> {
		const trimmed = checkedFact(fact, kind, eventDate);
		const [row]: Row[] = await this.#sql`
			INSERT INTO owner_memory (speaker_id, fact, kind, event_date)
			VALUES (${this.speakerId}, ${trimmed}, ${kind}, ${eventDate ?? null}::date)
			RETURNING id, kind, fact, to_char(event_date, 'YYYY-MM-DD') AS event_date`;
		if (!row) throw new MemoryError("the memory was not saved");
		return toMemory(row);
	}

	/**
	 * Memories containing any query term, case-insensitively, most terms matched first,
	 * then newest first.
	 */
	async search(query: string, limit = SEARCH_LIMIT): Promise<OwnerMemory[]> {
		const terms = searchTerms(query);
		if (terms.length === 0) throw new MemoryError("the search query is empty");
		const rows: (Row & { hits: number })[] = await this.#sql`
			SELECT id, kind, fact, to_char(event_date, 'YYYY-MM-DD') AS event_date, hits
			FROM (
				SELECT *, (
					SELECT count(*) FROM jsonb_array_elements_text(${terms}::jsonb) AS term
					WHERE strpos(lower(fact), term) > 0
				) AS hits
				FROM owner_memory WHERE speaker_id = ${this.speakerId}
			) AS scored
			WHERE hits > 0
			ORDER BY hits DESC, updated_at DESC, id DESC
			LIMIT ${limit}`;
		return rows.map(toMemory);
	}

	/** Replaces one memory's text, kind, and date under `add`'s rules; undefined when the id is unknown. */
	async update(
		id: number,
		change: { fact: string; kind: OwnerMemoryKind; eventDate?: string },
	): Promise<OwnerMemory | undefined> {
		const trimmed = checkedFact(change.fact, change.kind, change.eventDate);
		const [row]: Row[] = await this.#sql`
			UPDATE owner_memory
			SET fact = ${trimmed}, kind = ${change.kind},
				event_date = ${change.eventDate ?? null}::date, updated_at = now()
			WHERE speaker_id = ${this.speakerId} AND id = ${id}
			RETURNING id, kind, fact, to_char(event_date, 'YYYY-MM-DD') AS event_date`;
		return row ? toMemory(row) : undefined;
	}

	/** Deletes one memory; false when the id is unknown. */
	async removeById(id: number): Promise<boolean> {
		const rows = await this.#sql`DELETE FROM owner_memory
			WHERE speaker_id = ${this.speakerId} AND id = ${id} RETURNING id`;
		return rows.length > 0;
	}

	/** Deletes every memory containing the text, case-insensitively; returns the removed facts. */
	async remove(text: string): Promise<string[]> {
		const needle = text.trim();
		if (!needle) throw new MemoryError("the text to forget cannot be empty");
		const rows: { fact: string }[] = await this.#sql`
			DELETE FROM owner_memory
			WHERE speaker_id = ${this.speakerId} AND strpos(lower(fact), lower(${needle})) > 0
			RETURNING fact`;
		return rows.map((row) => row.fact);
	}
}
