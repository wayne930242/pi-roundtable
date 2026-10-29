import type { SQL } from "bun";
import { isCheckDatabase } from "../../db/check-database.ts";
import type { Migration } from "../../db/migrations.ts";
import { AgentError } from "../../domain/errors.ts";
import { type Logger, silentLogger } from "../../log.ts";
import {
	PromptHistory,
	type PromptVersion,
	promptHistoryMigration,
} from "./prompt-history.ts";

export type { PromptAction, PromptVersion } from "./prompt-history.ts";

/** The most characters a document may have unless its spec says otherwise. */
export const DEFAULT_DOCUMENT_CHARS = 20_000;

const DOCUMENT_ID = /^[a-z0-9-]{1,32}$/;

/** A prompt text the owner may edit, with the text from a file as its default. */
export interface PromptDocumentSpec {
	/** Lowercase letters, digits and hyphens; names the document for good. */
	id: string;
	/** What the owner sees it called. */
	label: string;
	/** One line on where the text is used. */
	description?: string;
	/**
	 * The file version: the text read from a file or the configuration. A function is called each
	 * time the document is read, so a default that follows a file is current.
	 */
	default: string | (() => string);
	/** Default 20,000. */
	maxChars?: number;
}

/** A registered document, read by whoever uses its text. */
export interface PromptHandle {
	readonly id: string;
	/** The text in force now: the owner's override while one is set, else the file version. */
	text(): string;
}

/** A document as the owner sees it. */
export interface PromptDocumentView {
	id: string;
	label: string;
	description?: string;
	/** The text in force. */
	text: string;
	/** The file version. */
	fileText: string;
	/** An owner's override is set. */
	overridden: boolean;
	/** The override is set and its text is not the file version. */
	differs: boolean;
	override?: { by: string; at: Date };
	maxChars: number;
	/**
	 * Why the file version cannot be read, when its `default` throws. The document is then listed
	 * with an empty `fileText`, `differs` false and the override as `text` (empty with none), and
	 * `set` and `revert` refuse it until the file reads again. One broken document never blanks
	 * the others.
	 */
	broken?: string;
}

/**
 * A change made from a text that is no longer the one in force: someone else changed the document
 * meanwhile. Nothing was written; `current` is what is in force now.
 */
export class PromptConflictError extends Error {
	override name = "PromptConflictError";
	constructor(readonly current: PromptDocumentView) {
		super(
			`The prompt document "${current.id}" changed while it was being edited.`,
		);
	}
}

/**
 * Prompt texts the owner edits outside the files: each has a file version, an optional override
 * stored in the database, and a history. The override wins while it is set and is read at every
 * turn, so a change applies from the next turn without a restart.
 */
export interface PromptDocuments {
	/**
	 * Registers a document during a plugin's setup. Throws AgentError for an unusable or repeated
	 * id, and for a `default` that cannot be read now: the host does not start with it.
	 */
	register(spec: PromptDocumentSpec): PromptHandle;
	/**
	 * The text in force; throws AgentError for an unknown id, and for a document with no override
	 * whose file version cannot be read (logged as an error naming the document).
	 */
	text(id: string): string;
	/** Every document, in the order they were registered. */
	list(): PromptDocumentView[];
	/** One document, or undefined for an unknown id. */
	get(id: string): PromptDocumentView | undefined;
	/**
	 * Sets the override. The text must have 1 to `maxChars` characters and differ from the text in
	 * force; text equal to the file version reverts instead. Throws AgentError otherwise.
	 *
	 * `base` is the text the change was edited from. When it is given and is not the text in force
	 * when the write comes up in the queue, nothing is written and PromptConflictError carries the
	 * document as it is now.
	 */
	set(
		id: string,
		text: string,
		by: string,
		base?: string,
	): Promise<PromptDocumentView>;
	/**
	 * Returns to the file version, dropping the override. Throws AgentError when none is set, and
	 * PromptConflictError as `set` does when `base` is not the text in force.
	 */
	revert(id: string, by: string, base?: string): Promise<PromptDocumentView>;
	/** The changes of one document, newest first. */
	history(id: string, limit?: number): Promise<PromptVersion[]>;
}

interface OverrideRow {
	name: string;
	text: string;
	by_name: string;
	at: Date;
}

interface Override {
	text: string;
	by: string;
	at: Date;
}

interface Registered {
	spec: PromptDocumentSpec;
}

const fileText = (spec: PromptDocumentSpec): string =>
	typeof spec.default === "function" ? spec.default() : spec.default;

/** What reading a document's file version gave: its text, or why it could not be read. */
type FileRead = { text: string } | { broken: string; error: unknown };

const readFile = (spec: PromptDocumentSpec): FileRead => {
	try {
		return { text: fileText(spec) };
	} catch (error) {
		return {
			broken: error instanceof Error ? error.message : String(error),
			error,
		};
	}
};

/** The documents of one guild (or the local team), with their overrides in PostgreSQL. */
export class PgPromptDocuments implements PromptDocuments {
	readonly #sql: SQL;
	readonly #guild: string;
	readonly #history: PromptHistory;
	readonly #logger: Logger;
	readonly #documents = new Map<string, Registered>();
	readonly #overrides = new Map<string, Override>();
	/** The tail of the writes, which run one at a time so none reads an override another is about to change. */
	#queue: Promise<unknown> = Promise.resolve();

	private constructor(sql: SQL, guildId: string, logger: Logger) {
		this.#sql = sql;
		this.#guild = guildId;
		this.#logger = logger;
		this.#history = new PromptHistory(sql, guildId);
	}

	/** The overrides and the history, created beside the agent server's own tables. */
	static migrations(): Migration[] {
		return [
			{
				name: "prompt-overrides",
				up: async (sql) => {
					await sql`
						CREATE TABLE IF NOT EXISTS prompt_overrides (
							guild_id text NOT NULL,
							name text NOT NULL,
							text text NOT NULL,
							by_name text NOT NULL,
							at timestamptz NOT NULL DEFAULT now(),
							PRIMARY KEY (guild_id, name)
						)`;
				},
			},
			promptHistoryMigration("prompt-history"),
		];
	}

	/**
	 * The documents over the host's migrated pool, holding the overrides of one guild. A file
	 * version that cannot be read is logged to `logger` as an error naming the document.
	 */
	static async attach(
		sql: SQL,
		guildId: string,
		logger: Logger = silentLogger(),
	): Promise<PgPromptDocuments> {
		const documents = new PgPromptDocuments(sql, guildId, logger);
		// `Roundtable.check()` has no database to read the rows from: nothing is overridden.
		if (!isCheckDatabase(sql)) await documents.#reload();
		return documents;
	}

	async #reload(): Promise<void> {
		const rows: OverrideRow[] = await this
			.#sql`SELECT name, text, by_name, at FROM prompt_overrides WHERE guild_id = ${this.#guild}`;
		this.#overrides.clear();
		for (const row of rows)
			this.#overrides.set(row.name, {
				text: row.text,
				by: row.by_name,
				at: new Date(row.at),
			});
	}

	#serial<T>(write: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(write);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	register(spec: PromptDocumentSpec): PromptHandle {
		if (!DOCUMENT_ID.test(spec.id))
			throw new AgentError(
				`"${spec.id}" is not a usable prompt document id: use 1 to 32 lowercase letters, digits and hyphens.`,
			);
		if (this.#documents.has(spec.id))
			throw new AgentError(`A prompt document "${spec.id}" already exists.`);
		if (!spec.label.trim())
			throw new AgentError(`The prompt document "${spec.id}" needs a label.`);
		// A default that cannot be read now stops the host here, not at the first turn that needs it.
		const read = readFile(spec);
		if ("broken" in read)
			throw new AgentError(
				`The prompt document "${spec.id}" has no readable file version: ${read.broken}`,
			);
		this.#documents.set(spec.id, { spec });
		return { id: spec.id, text: () => this.text(spec.id) };
	}

	#registered(id: string): PromptDocumentSpec {
		const found = this.#documents.get(id);
		if (!found) throw new AgentError(`There is no prompt document "${id}".`);
		return found.spec;
	}

	/** The file version, or an AgentError naming the document when it cannot be read; logged either way. */
	#file(spec: PromptDocumentSpec): string {
		const read = readFile(spec);
		if (!("broken" in read)) return read.text;
		this.#logUnreadable(spec, read.error);
		throw new AgentError(
			`The file version of the prompt document "${spec.id}" cannot be read: ${read.broken}`,
		);
	}

	#logUnreadable(spec: PromptDocumentSpec, error: unknown): void {
		this.#logger.error(
			{ document: spec.id, err: error },
			"the file version of a prompt document cannot be read",
		);
	}

	text(id: string): string {
		const spec = this.#registered(id);
		return this.#overrides.get(id)?.text ?? this.#file(spec);
	}

	#view(spec: PromptDocumentSpec): PromptDocumentView {
		const read = readFile(spec);
		const override = this.#overrides.get(spec.id);
		const common = {
			id: spec.id,
			label: spec.label,
			...(spec.description ? { description: spec.description } : {}),
			overridden: override !== undefined,
			...(override ? { override: { by: override.by, at: override.at } } : {}),
			maxChars: spec.maxChars ?? DEFAULT_DOCUMENT_CHARS,
		};
		if ("broken" in read) {
			this.#logUnreadable(spec, read.error);
			return {
				...common,
				text: override?.text ?? "",
				fileText: "",
				differs: false,
				broken: read.broken,
			};
		}
		return {
			...common,
			text: override?.text ?? read.text,
			fileText: read.text,
			differs: override !== undefined && override.text !== read.text,
		};
	}

	list(): PromptDocumentView[] {
		return [...this.#documents.values()].map(({ spec }) => this.#view(spec));
	}

	get(id: string): PromptDocumentView | undefined {
		const found = this.#documents.get(id);
		return found ? this.#view(found.spec) : undefined;
	}

	set(
		id: string,
		text: string,
		by: string,
		base?: string,
	): Promise<PromptDocumentView> {
		return this.#serial(async () => {
			const spec = this.#registered(id);
			const file = this.#file(spec);
			const now = this.#overrides.get(id)?.text ?? file;
			if (base !== undefined && base !== now)
				throw new PromptConflictError(this.#view(spec));
			const max = spec.maxChars ?? DEFAULT_DOCUMENT_CHARS;
			if (!text.trim() || text.length > max)
				throw new AgentError(
					`A prompt document must have 1 to ${max} characters; this one has ${text.length}.`,
				);
			if (text === now)
				throw new AgentError("The text is the one already in force.");
			if (text === file) return this.#revert(id, spec, file, by);
			const at = new Date();
			await this.#sql.begin(async (tx) => {
				await tx`
					INSERT INTO prompt_overrides (guild_id, name, text, by_name, at)
					VALUES (${this.#guild}, ${id}, ${text}, ${by}, ${at})
					ON CONFLICT (guild_id, name) DO UPDATE
					SET text = EXCLUDED.text, by_name = EXCLUDED.by_name, at = EXCLUDED.at`;
				await this.#history.record(
					"document",
					id,
					{ action: "set", text, previous: now, by },
					tx,
				);
			});
			// The cache follows the committed write.
			this.#overrides.set(id, { text, by, at });
			return this.#view(spec);
		});
	}

	revert(id: string, by: string, base?: string): Promise<PromptDocumentView> {
		return this.#serial(async () => {
			const spec = this.#registered(id);
			const file = this.#file(spec);
			if (
				base !== undefined &&
				base !== (this.#overrides.get(id)?.text ?? file)
			)
				throw new PromptConflictError(this.#view(spec));
			if (!this.#overrides.has(id))
				throw new AgentError(
					`"${id}" has no override; the file version is in force.`,
				);
			return this.#revert(id, spec, file, by);
		});
	}

	async #revert(
		id: string,
		spec: PromptDocumentSpec,
		file: string,
		by: string,
	): Promise<PromptDocumentView> {
		const previous = this.#overrides.get(id)?.text ?? file;
		await this.#sql.begin(async (tx) => {
			await tx`DELETE FROM prompt_overrides WHERE guild_id = ${this.#guild} AND name = ${id}`;
			await this.#history.record(
				"document",
				id,
				{ action: "revert", text: file, previous, by },
				tx,
			);
		});
		this.#overrides.delete(id);
		return this.#view(spec);
	}

	history(id: string, limit?: number): Promise<PromptVersion[]> {
		this.#registered(id);
		return this.#history.list("document", id, limit);
	}

	/**
	 * Says which documents differ from their file versions, and which overrides name a document
	 * nobody registers; the host calls it once every plugin has registered its own.
	 */
	logOverrides(logger: Logger): void {
		for (const [id, override] of this.#overrides) {
			const found = this.#documents.get(id);
			if (!found) {
				logger.warn(
					{ document: id, by: override.by },
					"a stored prompt override names a document no plugin registers; it is ignored",
				);
				continue;
			}
			const read = readFile(found.spec);
			if ("broken" in read) {
				logger.error(
					{ document: id, err: read.error },
					"the file version of a prompt document cannot be read",
				);
				continue;
			}
			if (override.text === read.text) continue;
			logger.warn(
				{ document: id, by: override.by, at: override.at.toISOString() },
				"a prompt document differs from its file version: the owner's override is in force until it is reverted in the app",
			);
		}
	}
}
