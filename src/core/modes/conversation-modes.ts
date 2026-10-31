import type { SQL } from "bun";
import type { Migration } from "../db/migrations.ts";
import { PluginError } from "../errors.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import {
	followersOf,
	type ModeOrigins,
	resolveMode,
	type StoredMode,
} from "./mode-inheritance.ts";

/** What a conversation is set to run unattended: both off until an owner switches them on. */
export interface ConversationMode {
	/** Held calls that are safe enough are approved by the server instead of asked on a card. */
	yolo: boolean;
	/** A turn that reaches its time limit goes on by itself, up to `autonomy.longRunning.maxSeconds`. */
	longRunning: boolean;
	/** The principal who last changed it; absent for a conversation never changed. */
	changedBy?: string;
	changedAt?: Date;
	/**
	 * Present when the modes follow another conversation's, live: a temp knight's follow the
	 * conversation it was made from. `name` is that conversation's, as the agent server tells it;
	 * `gone` says it no longer exists, so both modes are off. `set` refuses such a conversation.
	 */
	inheritedFrom?: { channel: ChannelKey; name?: string; gone?: true };
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
	/**
	 * Makes each of `channels` follow `origin`'s modes live, in place of its own: `peek` returns the
	 * origin's, with `inheritedFrom`, and `set` is refused for it. Stored, so it survives a restart.
	 * Throws `PluginError` unless `by` is an owner other than the system principal, as `set` does.
	 */
	follow(
		channels: readonly ChannelKey[],
		origin: ChannelKey,
		by: Speaker,
	): Promise<void>;
	/**
	 * Drops a conversation's modes and what it follows, as for a conversation that is gone or made
	 * anew. It only turns modes off, so it needs no speaker.
	 */
	forget(channel: ChannelKey): Promise<void>;
	/**
	 * How a following conversation's origin is named and whether it still exists; the agent server
	 * gives it. `originOf` is undefined when `channel` no longer follows `origin`, so its own modes
	 * count again; `alive: false` when the origin is gone, so both modes read off.
	 */
	trackOrigins(origins: {
		originOf(
			channel: ChannelKey,
			origin: ChannelKey,
		): { name: string; alive: boolean } | undefined;
	}): void;
	/** Called after each change, also for each conversation that follows the changed one. Returns the function that stops it. A throwing listener is logged. */
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
	follows: string | null;
}

function storedOf(row: Row): StoredMode {
	return {
		own: Object.freeze({
			yolo: row.yolo,
			longRunning: row.long_running,
			...(row.changed_by === null ? {} : { changedBy: row.changed_by }),
			changedAt: row.changed_at,
		}),
		...(row.follows === null ? {} : { follows: row.follows as ChannelKey }),
	};
}

/** Refuses a change of modes by anyone but an owner, and by the host's own turns. */
function checkOwner(by: Speaker): void {
	if (by.tier !== "owner" || by.principalId === SYSTEM_PRINCIPAL)
		throw new PluginError(
			"only an owner sets a conversation's modes, and not the host's own turns",
		);
}

/** The conversation modes in the `conversation_modes` table, cached in memory after one load. */
export class PgConversationModes implements ConversationModes {
	readonly #sql: SQL;
	readonly #logger: Logger;
	readonly #modes = new Map<ChannelKey, StoredMode>();
	#origins: ModeOrigins | undefined;
	readonly #changed = new Set<
		(channel: ChannelKey, mode: ConversationMode) => void
	>();
	readonly #approved = new Set<(entry: AutoApproval) => void>();

	private constructor(sql: SQL, logger: Logger) {
		this.#sql = sql;
		this.#logger = logger;
	}

	/** The modes' table; the host runs this, then `followsMigration`, before the modes attach. */
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

	/** The conversation whose modes a row follows, such as a temp knight's origin. */
	static readonly followsMigration: Migration = {
		name: "conversation-modes-follows",
		up: async (sql) => {
			await sql`ALTER TABLE conversation_modes ADD COLUMN IF NOT EXISTS follows text`;
		},
	};

	/** Every migration of the modes' table, in order. */
	static readonly migrations: readonly Migration[] = [
		PgConversationModes.migration,
		PgConversationModes.followsMigration,
	];

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
		// A mode `set` wrote while the rows were read is newer than its row here.
		for (const row of rows)
			if (!this.#modes.has(row.channel as ChannelKey))
				this.#modes.set(row.channel as ChannelKey, storedOf(row));
	}

	peek(channel: ChannelKey): ConversationMode {
		return resolveMode(channel, (key) => this.#modes.get(key), this.#origins);
	}

	trackOrigins(origins: ModeOrigins): void {
		this.#origins = origins;
	}

	async set(
		channel: ChannelKey,
		change: ModeChange,
		by: Speaker,
	): Promise<ConversationMode> {
		checkOwner(by);
		const inherited = this.peek(channel).inheritedFrom;
		if (inherited)
			throw new PluginError(
				`this conversation follows the modes of ${inherited.name ?? inherited.channel}; change them there`,
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
				changed_at = now(),
				follows = NULL
			RETURNING *`;
		const [row] = rows;
		if (!row)
			throw new Error(`conversation modes of ${channel} were not stored`);
		this.#modes.set(channel, storedOf(row));
		const mode = this.peek(channel);
		this.#logger.info(
			{
				channel,
				yolo: mode.yolo,
				longRunning: mode.longRunning,
				by: by.principalId,
			},
			"conversation modes changed",
		);
		this.#announce(channel);
		return mode;
	}

	async follow(
		channels: readonly ChannelKey[],
		origin: ChannelKey,
		by: Speaker,
	): Promise<void> {
		checkOwner(by);
		for (const channel of channels) {
			// Its own modes go off: they count again only once it no longer follows.
			const rows: Row[] = await this.#sql`
				INSERT INTO conversation_modes (channel, yolo, long_running, changed_by, changed_at, follows)
				VALUES (${channel}, false, false, ${by.principalId}, now(), ${origin})
				ON CONFLICT (channel) DO UPDATE SET
					yolo = false, long_running = false, changed_by = ${by.principalId},
					changed_at = now(), follows = ${origin}
				RETURNING *`;
			const [row] = rows;
			if (!row)
				throw new Error(`conversation modes of ${channel} were not stored`);
			this.#modes.set(channel, storedOf(row));
			this.#logger.info(
				{ channel, origin, by: by.principalId },
				"conversation modes follow another conversation",
			);
			this.#announce(channel);
		}
	}

	async forget(channel: ChannelKey): Promise<void> {
		await this.#sql`DELETE FROM conversation_modes WHERE channel = ${channel}`;
		if (!this.#modes.delete(channel)) return;
		this.#logger.info({ channel }, "conversation modes forgotten");
		this.#announce(channel);
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

	/** Tells the listeners of `channel`'s modes, and of each conversation that follows it. */
	#announce(channel: ChannelKey): void {
		for (const key of [
			channel,
			...followersOf(channel, this.#modes, this.#origins),
		]) {
			const mode = this.peek(key);
			this.#tell(this.#changed, "change", (listener) => listener(key, mode));
		}
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
