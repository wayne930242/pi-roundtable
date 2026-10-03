import type { SQL } from "bun";
import type { Migration } from "../../db/migrations.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import { ScheduleError } from "../../domain/errors.ts";
import type { ScheduleStore } from "../../services.ts";
import type { Tier } from "../../speakers.ts";
import type { Recurrence } from "./recurrence.ts";

export interface Schedule {
	id: number;
	channel: ChannelKey;
	/** The name of the background target whose conversation runs it; stored in the `mode` column. */
	target: string;
	title: string;
	prompt: string;
	recurrence: Recurrence;
	nextRun: Date;
	createdById: string;
	createdByName: string;
	/** The creator's tier when it was set; the schedule runs at it and lower tiers may not change it. */
	createdTier: Tier;
	createdAt: Date;
	/** The name of the precheck the host runs before its turn; absent, the turn always runs. */
	precheck?: string;
	/** The precheck script an agent wrote for it, run in the host's sandbox; a schedule has a name or a script, not both. */
	precheckScript?: string;
	lastRun?: Date;
	lastStatus?: string;
}

export interface NewSchedule {
	channel: ChannelKey;
	target: string;
	title: string;
	prompt: string;
	recurrence: Recurrence;
	nextRun: Date;
	createdById: string;
	createdByName: string;
	createdTier: Tier;
	/** A registered precheck's name, run before each turn. */
	precheck?: string;
	/** A precheck script, run in the host's sandbox before each turn; not with `precheck`. */
	precheckScript?: string;
}

export interface ScheduleChange {
	title?: string;
	prompt?: string;
	recurrence?: Recurrence;
	nextRun?: Date;
	/** A registered precheck's name to run before each turn; null removes the schedule's precheck. */
	precheck?: string | null;
	/** A precheck script to run before each turn; null removes it. */
	precheckScript?: string | null;
}

interface Row {
	id: string | number;
	channel_key: ChannelKey;
	/** The target's name; the column keeps the name it had before targets existed. */
	mode: string;
	title: string;
	prompt: string;
	recurrence: string;
	next_run: Date;
	created_by_id: string;
	created_by_name: string;
	created_tier: Tier;
	created_at: Date;
	precheck: string | null;
	precheck_script: string | null;
	last_run: Date | null;
	last_status: string | null;
}

function toSchedule(row: Row): Schedule {
	return {
		id: Number(row.id),
		channel: row.channel_key,
		target: row.mode,
		title: row.title,
		prompt: row.prompt,
		// pi-lens-ignore: unchecked-throwing-call — this store wrote the JSON; a corrupt row should fail loudly
		recurrence: JSON.parse(row.recurrence) as Recurrence,
		nextRun: row.next_run,
		createdById: row.created_by_id,
		createdByName: row.created_by_name,
		createdTier: row.created_tier,
		createdAt: row.created_at,
		...(row.precheck ? { precheck: row.precheck } : {}),
		...(row.precheck_script ? { precheckScript: row.precheck_script } : {}),
		...(row.last_run ? { lastRun: row.last_run } : {}),
		...(row.last_status ? { lastStatus: row.last_status } : {}),
	};
}

/** Scheduled turns, in the database. A one-time schedule's row is deleted once it fires. */
export class PgScheduleStore implements ScheduleStore {
	readonly #sql: SQL;

	private constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = {
		name: "schedules",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS schedules (
					id bigserial PRIMARY KEY,
					channel_key text NOT NULL,
					mode text NOT NULL,
					title text NOT NULL,
					prompt text NOT NULL,
					recurrence text NOT NULL,
					next_run timestamptz NOT NULL,
					created_by_id text NOT NULL,
					created_by_name text NOT NULL,
					created_at timestamptz NOT NULL DEFAULT now(),
					last_run timestamptz,
					last_status text
				)`;
			// Schedules made before tiers existed were the owner's.
			await sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS created_tier text NOT NULL DEFAULT 'owner'`;
			await sql`CREATE INDEX IF NOT EXISTS schedules_next_run ON schedules (next_run)`;
			await sql`CREATE INDEX IF NOT EXISTS schedules_channel ON schedules (channel_key)`;
		},
	};

	/** The table, then the precheck each schedule may name or carry; schedules made before prechecks have none. */
	static migrations(): Migration[] {
		return [
			PgScheduleStore.migration,
			{
				name: "schedules-precheck",
				up: async (sql) => {
					await sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS precheck text`;
				},
			},
			{
				name: "schedules-precheck-script",
				up: async (sql) => {
					await sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS precheck_script text`;
				},
			},
		];
	}

	/** The store over the host's migrated pool. */
	static async attach(sql: SQL): Promise<PgScheduleStore> {
		return new PgScheduleStore(sql);
	}

	async create(schedule: NewSchedule): Promise<Schedule> {
		if (schedule.precheck && schedule.precheckScript)
			throw new ScheduleError(
				"a schedule has a precheck or a precheck script, not both",
			);
		const rows: Row[] = await this.#sql`
			INSERT INTO schedules (channel_key, mode, title, prompt, recurrence, next_run,
				created_by_id, created_by_name, created_tier, precheck, precheck_script)
			VALUES (${schedule.channel}, ${schedule.target}, ${schedule.title}, ${schedule.prompt},
				${JSON.stringify(schedule.recurrence)}, ${schedule.nextRun},
				${schedule.createdById}, ${schedule.createdByName}, ${schedule.createdTier},
				${schedule.precheck ?? null}, ${schedule.precheckScript ?? null})
			RETURNING *`;
		const [row] = rows;
		if (!row) throw new Error("the schedule insert returned no row");
		return toSchedule(row);
	}

	async get(id: number): Promise<Schedule | undefined> {
		const rows: Row[] = await this
			.#sql`SELECT * FROM schedules WHERE id = ${id}`;
		return rows[0] ? toSchedule(rows[0]) : undefined;
	}

	async forChannel(channel: ChannelKey): Promise<Schedule[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM schedules WHERE channel_key = ${channel} ORDER BY next_run`;
		return rows.map(toSchedule);
	}

	async all(): Promise<Schedule[]> {
		const rows: Row[] = await this
			.#sql`SELECT * FROM schedules ORDER BY next_run`;
		return rows.map(toSchedule);
	}

	/** Applies a change to one of the channel's schedules; undefined when it has no such schedule. */
	async update(
		channel: ChannelKey,
		id: number,
		change: ScheduleChange,
	): Promise<Schedule | undefined> {
		const current = await this.get(id);
		if (!current || current.channel !== channel) return undefined;
		if (change.precheck && change.precheckScript)
			throw new ScheduleError(
				"a schedule has a precheck or a precheck script, not both",
			);
		// Setting one removes the other, so the scheduler never has to pick.
		const precheck = change.precheckScript
			? null
			: change.precheck === undefined
				? (current.precheck ?? null)
				: change.precheck;
		const precheckScript = change.precheck
			? null
			: change.precheckScript === undefined
				? (current.precheckScript ?? null)
				: change.precheckScript;
		const rows: Row[] = await this.#sql`
			UPDATE schedules SET
				title = ${change.title ?? current.title},
				prompt = ${change.prompt ?? current.prompt},
				recurrence = ${JSON.stringify(change.recurrence ?? current.recurrence)},
				next_run = ${change.nextRun ?? current.nextRun},
				precheck = ${precheck},
				precheck_script = ${precheckScript}
			WHERE id = ${id}
			RETURNING *`;
		return rows[0] ? toSchedule(rows[0]) : undefined;
	}

	/** Deletes a schedule, only from the given channel when one is given. */
	async remove(
		id: number,
		channel?: ChannelKey,
	): Promise<Schedule | undefined> {
		const rows: Row[] = channel
			? await this.#sql`
				DELETE FROM schedules WHERE id = ${id} AND channel_key = ${channel} RETURNING *`
			: await this.#sql`DELETE FROM schedules WHERE id = ${id} RETURNING *`;
		return rows[0] ? toSchedule(rows[0]) : undefined;
	}

	async due(now: Date): Promise<Schedule[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM schedules WHERE next_run <= ${now} ORDER BY next_run`;
		return rows.map(toSchedule);
	}

	/**
	 * Takes a due schedule before it runs: moves it to its next run, or deletes it when there
	 * is none. The next_run guard makes a second claim of the same run a no-op.
	 */
	async claim(
		schedule: Schedule,
		next: Date | undefined,
		now: Date,
	): Promise<boolean> {
		const rows: unknown[] = next
			? await this.#sql`
				UPDATE schedules SET next_run = ${next}, last_run = ${now}, last_status = 'running'
				WHERE id = ${schedule.id} AND next_run = ${schedule.nextRun}
				RETURNING id`
			: await this.#sql`
				DELETE FROM schedules WHERE id = ${schedule.id} AND next_run = ${schedule.nextRun}
				RETURNING id`;
		return rows.length > 0;
	}

	/** Records how a run ended; a deleted one-time schedule has no row left to update. */
	async recordStatus(id: number, status: string): Promise<void> {
		await this
			.#sql`UPDATE schedules SET last_status = ${status} WHERE id = ${id}`;
	}
}
