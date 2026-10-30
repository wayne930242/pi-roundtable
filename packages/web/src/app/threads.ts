import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";

/** A dispatch thread of the app: a read-only room that holds one exchange between agents. */
export interface WebThread {
	/** `thread.<uuid>`; the room key is `<surface>:<id>`. */
	id: string;
	parent: string;
	title: string;
	open: boolean;
	createdAt: Date;
}

interface Row {
	id: string;
	parent: string;
	title: string;
	open: boolean;
	created_at: Date;
}

const threadOf = (row: Row): WebThread => ({
	id: row.id,
	parent: row.parent,
	title: row.title,
	open: row.open,
	createdAt: row.created_at,
});

/** The most closed threads the room list still shows. */
const CLOSED_LISTED = 30;

/** The most characters of a thread's title. */
const TITLE_CHARS = 80;

/**
 * The threads of the app in `web_threads`. A thread is a room the page can read and nobody can
 * write in. `open` makes one under a parent room and returns its id; `close` ends it, and a
 * closed thread stays readable. Posting into a thread and showing it in the page are the app's;
 * this is only the record.
 */
export class WebThreads {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-threads",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_threads (
					id text PRIMARY KEY,
					parent text NOT NULL,
					title text NOT NULL,
					open boolean NOT NULL DEFAULT true,
					created_at timestamptz NOT NULL DEFAULT now()
				)`;
		},
	};

	/** The mark of a finished thread the owners took off the room list; the thread itself stays. */
	static readonly dismissedMigration: Migration = {
		name: "web-threads-dismissed",
		up: async (sql) => {
			await sql`
				ALTER TABLE web_threads ADD COLUMN IF NOT EXISTS dismissed_at timestamptz`;
		},
	};

	/** Starts a thread under `parent`. */
	async open(parent: string, title: string): Promise<WebThread> {
		const id = `thread.${crypto.randomUUID()}`;
		const cut =
			Array.from(title.trim()).slice(0, TITLE_CHARS).join("") || "Thread";
		const [row]: Row[] = await this.#sql`
			INSERT INTO web_threads (id, parent, title) VALUES (${id}, ${parent}, ${cut})
			RETURNING *`;
		if (!row) throw new Error("the thread was not stored");
		return threadOf(row);
	}

	async close(id: string): Promise<void> {
		await this.#sql`UPDATE web_threads SET open = false WHERE id = ${id}`;
	}

	/**
	 * Takes a finished thread off the room list. It stays readable by its address, and asking again
	 * changes nothing. An open thread is refused: `open` says so, `missing` that there is none.
	 */
	async dismiss(id: string): Promise<"dismissed" | "open" | "missing"> {
		const rows: unknown[] = await this.#sql`
			UPDATE web_threads SET dismissed_at = COALESCE(dismissed_at, now())
			WHERE id = ${id} AND NOT open RETURNING 1`;
		if (rows.length) return "dismissed";
		return (await this.get(id)) ? "open" : "missing";
	}

	/** Dismisses every finished thread under `parent` that is still listed; returns how many. */
	async dismissFinished(parent: string): Promise<number> {
		const rows: unknown[] = await this.#sql`
			UPDATE web_threads SET dismissed_at = now()
			WHERE parent = ${parent} AND NOT open AND dismissed_at IS NULL RETURNING 1`;
		return rows.length;
	}

	/** Puts a dismissed thread back on the room list; asking again changes nothing. */
	async restore(id: string): Promise<"restored" | "missing"> {
		const rows: unknown[] = await this.#sql`
			UPDATE web_threads SET dismissed_at = NULL WHERE id = ${id} RETURNING 1`;
		return rows.length ? "restored" : "missing";
	}

	/** Puts back the dismissed threads of `ids` that hang under `parent`; returns how many were dismissed. */
	async restoreFinished(
		parent: string,
		ids: readonly string[],
	): Promise<number> {
		if (ids.length === 0) return 0;
		const rows: unknown[] = await this.#sql`
			UPDATE web_threads SET dismissed_at = NULL
			WHERE parent = ${parent} AND id IN ${this.#sql([...ids])}
				AND dismissed_at IS NOT NULL RETURNING 1`;
		return rows.length;
	}

	async get(id: string): Promise<WebThread | undefined> {
		const [row]: Row[] = await this
			.#sql`SELECT * FROM web_threads WHERE id = ${id}`;
		return row && threadOf(row);
	}

	/** Every thread under `parent`, open or closed. */
	async under(parent: string): Promise<WebThread[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM web_threads WHERE parent = ${parent} ORDER BY created_at, id`;
		return rows.map(threadOf);
	}

	/** Deletes every thread under a room that is gone for good; returns how many. */
	async removeUnder(parent: string): Promise<number> {
		const rows: unknown[] = await this
			.#sql`DELETE FROM web_threads WHERE parent = ${parent} RETURNING 1`;
		return rows.length;
	}

	/**
	 * The threads the room list shows, newest first: every open one, and the `closedLimit` newest
	 * closed ones that were not dismissed. The rest stay readable but are not kept in view.
	 */
	async list(closedLimit = CLOSED_LISTED): Promise<WebThread[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM (
				SELECT * FROM web_threads WHERE open
				UNION ALL
				(SELECT * FROM web_threads WHERE NOT open AND dismissed_at IS NULL
					ORDER BY created_at DESC, id LIMIT ${closedLimit})
			) shown ORDER BY created_at DESC, id`;
		return rows.map(threadOf);
	}
}
