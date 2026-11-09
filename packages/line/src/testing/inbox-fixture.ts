import { afterAll, beforeEach, expect } from "bun:test";
import type { SQL } from "bun";
import { recordingLogger } from "pi-roundtable/testing";
import { parseWebhook } from "../events.ts";
import {
	type InboxEvent,
	type InboxOptions,
	type InboxProcessor,
	InboxWorker,
} from "../inbox.ts";
import { persistEvents } from "../intake.ts";
import { PgSources } from "../sources.ts";
import { body, GROUP, messageEvent, OTHER_GROUP } from "./line-fake.ts";
import { freshPool } from "./pool.ts";

export const START = new Date("2026-10-13T00:00:00Z");

export let sql: SQL;

export let time = START;

export const handled: InboxEvent[] = [];

/** The processor the worker under test hands events to; a test replaces it. */
export const state: { processor: InboxProcessor | undefined } = {
	processor: undefined,
};

export const logs = recordingLogger();

export const advance = (ms: number) => {
	time = new Date(time.getTime() + ms);
};

export const sources = () =>
	new PgSources(
		sql,
		() => ({}) as never,
		() => time,
	);

export const worker = (options: Partial<InboxOptions> = {}) =>
	new InboxWorker({
		sql,
		logger: logs.logger,
		now: () => time,
		sources: sources(),
		processor: () => state.processor,
		random: () => 1,
		options: { pollMs: 20, ...options },
	});

export const receive = async (...events: Record<string, unknown>[]) =>
	persistEvents(
		sql,
		(await parseWebhook(new TextEncoder().encode(body(...events)))).events,
		time,
	);

/** Allows the two test groups, then stores `events`. */
export const store = async (...events: Record<string, unknown>[]) => {
	await receive(
		messageEvent({ id: "seed-a" }),
		messageEvent({ id: "seed-b", group: "Cgroup0002" }),
	);
	await sources().allow(GROUP);
	await sources().allow(OTHER_GROUP);
	await receive(...events);
};

export const row = async (id: string) =>
	(await sql`SELECT * FROM line_inbox WHERE webhook_event_id = ${id}`)[0];

/** An `unsend` of `messageId`. */
export const unsendOf = (id: string, messageId: string, timestamp: number) => ({
	...messageEvent({ id, timestamp, type: "unsend" }),
	message: undefined,
	unsend: { messageId },
});

/** A `messageEdited` of `messageId`. */
export const editOf = (id: string, messageId: string, timestamp: number) =>
	messageEvent({ id, timestamp, type: "messageEdited", messageId });

/** Lets the next `handled` entry appear, for a handler that runs in the background. */
export const until = async (done: () => boolean) => {
	for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(10);
	expect(done()).toBe(true);
};

export const membership = (id: string, type: string, timestamp: number) => ({
	...messageEvent({ id, timestamp, type }),
	message: undefined,
});

export function useInboxHarness() {
	beforeEach(async () => {
		sql ??= await freshPool();
		await sql`TRUNCATE line_inbox, line_sources`;
		time = START;
		handled.length = 0;
		state.processor = async (event) => {
			handled.push(event);
			return undefined;
		};
		logs.lines.length = 0;
	});

	afterAll(async () => {
		await sql?.close();
		// The next file opens its own pool.
		sql = undefined as never;
	});
}
