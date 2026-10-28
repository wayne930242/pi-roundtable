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

/** The most characters of a thread's title. */
const TITLE_CHARS = 80;

/**
 * The threads of the app in `web_threads`. A thread is a room the page can read and nobody can
 * write in. `open` makes one under a parent room and returns its id; `close` ends it. Posting
 * into a thread and showing it in the page are the app's; this is only the record.
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

	async get(id: string): Promise<WebThread | undefined> {
		const [row]: Row[] = await this
			.#sql`SELECT * FROM web_threads WHERE id = ${id}`;
		return row && threadOf(row);
	}

	/** The threads still open, newest first. */
	async listOpen(): Promise<WebThread[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM web_threads WHERE open ORDER BY created_at DESC, id`;
		return rows.map(threadOf);
	}
}
