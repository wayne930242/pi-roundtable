import { afterAll, beforeEach } from "bun:test";
import type { SQL } from "bun";
import { recordingLogger } from "pi-roundtable/testing";
import { LineApi } from "../api.ts";
import type { LineOutboxResultEvent } from "../messages.ts";
import { type OutboxOptions, PgOutbox } from "../outbox.ts";
import { OutboxWorker } from "../outbox-worker.ts";
import { QuotaGate } from "../quota.ts";
import { PgSources } from "../sources.ts";
import { TokenSource } from "../token.ts";
import {
	CHANNEL_ID,
	fakeLine,
	GROUP,
	OTHER_GROUP,
	SECRET,
} from "./line-fake.ts";
import { freshPool, truncateAll } from "./pool.ts";

export const BASE = Date.parse("2026-10-13T00:00:00Z");

export const USER = "line:user:Uuser0001";

export const text = (value: string) => ({ type: "text", text: value });

export const SENDER = {
	name: "Ada｜Support",
	iconUrl: "https://icons.example.test/staff.png",
};

export const OTHER_SENDER = {
	name: "Grace",
	iconUrl: "https://icons.example.test/staff.png",
};

export interface Row {
	id: string | number;
	source_key: string;
	sender_name: string | null;
	messages: { type: string; text?: string; sender?: unknown }[] | null;
	message_count: number;
	origin_refs: (string | null)[];
	retry_key: string;
	recipients: number | null;
	status: string;
	attempts: number;
	requested_at: Date | null;
	last_error_code: string | null;
	line_request_id: string | null;
	notified_at: Date | null;
}

export let sql: SQL;

/** What a test turns: the fake clock in ms, whether a subscriber hears results, and the error it throws. */
export const ctl: {
	clock: number;
	hearing: boolean;
	emitError: Error | undefined;
} = {
	clock: 0,
	hearing: true,
	emitError: undefined,
};

export const now = () => new Date(BASE + ctl.clock);

export const logs = recordingLogger();

export let fake = fakeLine();

export const results: LineOutboxResultEvent[] = [];

export let outbox: PgOutbox;

export let worker: OutboxWorker;

export let quota: QuotaGate;

export const build = (
	options: Partial<OutboxOptions> = {},
	monthlyCap?: number,
) => {
	const api = new LineApi({
		tokens: new TokenSource({
			credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
			fetch: fake.fetch,
		}),
		fetch: fake.fetch,
	});
	const sources = new PgSources(sql, () => api, now);
	quota = new QuotaGate({
		api,
		now,
		...(monthlyCap === undefined ? {} : { options: { monthlyCap } }),
	});
	outbox = new PgOutbox({ sql, now, sources, options });
	worker = new OutboxWorker({
		sql,
		logger: logs.logger,
		now,
		api,
		quota,
		sources,
		random: () => 1,
		emit: async (event) => {
			if (!ctl.hearing) return false;
			if (ctl.emitError) throw ctl.emitError;
			results.push(event);
			return true;
		},
		options,
	});
};

export const rows = async () =>
	Array.from(await sql`SELECT * FROM line_outbox ORDER BY id`) as Row[];

export const allow = async (key: string, status = "allowed") => {
	const kind = key.split(":")[1];
	await sql`INSERT INTO line_sources (source_key, kind, status, first_seen_at, last_seen_at, status_changed_at)
		VALUES (${key}, ${kind}, ${status}, ${now()}, ${now()}, ${now()})
		ON CONFLICT (source_key) DO UPDATE SET status = ${status}`;
};

/** Sends everything that is due, one push at a time. */
export const drain = async () => {
	let sent = 0;
	while (await worker.runOnce()) sent++;
	return sent;
};

export function useOutboxHarness() {
	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		ctl.clock = 0;
		fake = fakeLine();
		results.length = 0;
		ctl.hearing = true;
		ctl.emitError = undefined;
		logs.lines.length = 0;
		build();
		await allow(GROUP);
		await allow(OTHER_GROUP);
		await allow(USER);
	});

	afterAll(async () => {
		await sql?.close();
		// The next file opens its own pool.
		sql = undefined as never;
	});
}
