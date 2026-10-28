import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import { PluginError } from "../errors.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";

/** What a conversation is set to run unattended: both off until an owner switches them on. */
export interface ConversationMode {
	/** Held calls that are safe enough are approved by the server instead of asked on a card. */
	yolo: boolean;
	/** A turn that reaches its time limit goes on by itself, up to `autonomy.longRunning.maxSeconds`. */
	longRunning: boolean;
	/** The principal who last changed it; absent for a conversation never changed. */
	changedBy?: string;
	changedAt?: Date;
}

/** Which modes a change sets; a mode left out stays as it is. */
export interface ModeChange {
	yolo?: boolean;
	longRunning?: boolean;
}

/** A held call the server approved in yolo mode, for the room's log and the people watching it. */
export interface AutoApproval {
	channel: ChannelKey;
	tool: string;
	/** What the call would do, as the card would have said. */
	action: string;
	/** The hold classes that were all inside what yolo may approve. */
	classes: readonly string[];
	/** The owner whose message started the turn. */
	principalId: string;
	at: Date;
}

/**
 * The per-conversation modes, provided as `MODES`. They are stored per conversation key, so they
 * work for any surface; a surface decides who may toggle them. Every mode survives a restart.
 */
export interface ConversationModes {
	/** A conversation's modes from memory, both off by default; never waits on the database. */
	peek(channel: ChannelKey): ConversationMode;
	/**
	 * Sets the modes `change` names and stores them before they take effect; resolves with the
	 * result. Throws `PluginError` unless `by` is an owner other than the system principal, so the
	 * host's own turns and webhook-borne speakers cannot switch a conversation to run unattended.
	 */
	set(
		channel: ChannelKey,
		change: ModeChange,
		by: Speaker,
	): Promise<ConversationMode>;
	/** Called after each change. Returns the function that stops it. A throwing listener is logged. */
	onChange(
		listener: (channel: ChannelKey, mode: ConversationMode) => void,
	): () => void;
	/** Records that yolo mode approved a held call: logs it and tells `onAutoApproved` listeners. */
	autoApproved(entry: AutoApproval): void;
	onAutoApproved(listener: (entry: AutoApproval) => void): () => void;
}

interface Row {
	channel: string;
	yolo: boolean;
	long_running: boolean;
	changed_by: string | null;
	changed_at: Date;
}

const OFF: ConversationMode = Object.freeze({
	yolo: false,
	longRunning: false,
});

function modeOf(row: Row): ConversationMode {
	return Object.freeze({
		yolo: row.yolo,
		longRunning: row.long_running,
		...(row.changed_by === null ? {} : { changedBy: row.changed_by }),
		changedAt: row.changed_at,
	});
}

/** The conversation modes in the `conversation_modes` table, cached in memory after one load. */
export class PgConversationModes implements ConversationModes {
	readonly #sql: SQL;
	readonly #logger: Logger;
	readonly #modes = new Map<ChannelKey, ConversationMode>();
	readonly #changed = new Set<
		(channel: ChannelKey, mode: ConversationMode) => void
	>();
	readonly #approved = new Set<(entry: AutoApproval) => void>();

	private constructor(sql: SQL, logger: Logger) {
		this.#sql = sql;
		this.#logger = logger;
	}

	/** The modes' table; the host runs this before the modes attach. */
	static readonly migration: Migration = {
		name: "conversation-modes",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS conversation_modes (
					channel text PRIMARY KEY,
					yolo boolean NOT NULL DEFAULT false,
					long_running boolean NOT NULL DEFAULT false,
					changed_by text,
					changed_at timestamptz NOT NULL DEFAULT now()
				)`;
		},
	};

	/**
	 * The modes over the host's migrated pool, with none loaded: `Roundtable.check()` opens no
	 * connection, so the rows are read by `load`, from the plugin's service start.
	 */
	static attach(sql: SQL, logger: Logger): PgConversationModes {
		return new PgConversationModes(sql, logger);
	}

	/** Reads every stored row into memory; until then every conversation reads as both modes off. */
	async load(): Promise<void> {
		const rows: Row[] = await this.#sql`SELECT * FROM conversation_modes`;
		for (const row of rows)
			this.#modes.set(row.channel as ChannelKey, modeOf(row));
	}

	peek(channel: ChannelKey): ConversationMode {
		return this.#modes.get(channel) ?? OFF;
	}

	async set(
		channel: ChannelKey,
		change: ModeChange,
		by: Speaker,
	): Promise<ConversationMode> {
		if (by.tier !== "owner" || by.principalId === SYSTEM_PRINCIPAL)
			throw new PluginError(
				"only an owner sets a conversation's modes, and not the host's own turns",
			);
		const yolo = change.yolo ?? null;
		const longRunning = change.longRunning ?? null;
		// One statement, so two changes that name different modes cannot undo each other.
		const rows: Row[] = await this.#sql`
			INSERT INTO conversation_modes (channel, yolo, long_running, changed_by, changed_at)
			VALUES (${channel}, COALESCE(${yolo}::boolean, false),
				COALESCE(${longRunning}::boolean, false), ${by.principalId}, now())
			ON CONFLICT (channel) DO UPDATE SET
				yolo = COALESCE(${yolo}::boolean, conversation_modes.yolo),
				long_running = COALESCE(${longRunning}::boolean, conversation_modes.long_running),
				changed_by = ${by.principalId},
				changed_at = now()
			RETURNING *`;
		const [row] = rows;
		if (!row)
			throw new Error(`conversation modes of ${channel} were not stored`);
		const mode = modeOf(row);
		this.#modes.set(channel, mode);
		this.#logger.info(
			{
				channel,
				yolo: mode.yolo,
				longRunning: mode.longRunning,
				by: by.principalId,
			},
			"conversation modes changed",
		);
		this.#tell(this.#changed, "change", (listener) => listener(channel, mode));
		return mode;
	}

	onChange(
		listener: (channel: ChannelKey, mode: ConversationMode) => void,
	): () => void {
		this.#changed.add(listener);
		return () => void this.#changed.delete(listener);
	}

	autoApproved(entry: AutoApproval): void {
		this.#logger.info(
			{
				channel: entry.channel,
				tool: entry.tool,
				classes: entry.classes,
				principalId: entry.principalId,
			},
			"held call approved by yolo mode",
		);
		this.#tell(this.#approved, "auto-approval", (listener) => listener(entry));
	}

	onAutoApproved(listener: (entry: AutoApproval) => void): () => void {
		this.#approved.add(listener);
		return () => void this.#approved.delete(listener);
	}

	/** Runs each listener; one that throws is logged and the rest still hear it. */
	#tell<L>(listeners: Set<L>, what: string, call: (listener: L) => void): void {
		for (const listener of [...listeners]) {
			try {
				call(listener);
			} catch (error) {
				this.#logger.error({ err: error }, `a ${what} listener threw`);
			}
		}
	}
}
