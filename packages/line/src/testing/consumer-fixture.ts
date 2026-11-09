import { afterAll, beforeEach } from "bun:test";
import type { SQL } from "bun";
import { recordingLogger } from "pi-roundtable/testing";
import { LineConsumer } from "../consumer.ts";
import { parseWebhook } from "../events.ts";
import type { InboxEvent, InboxProcessor } from "../inbox.ts";
import type {
	LineContext,
	LineEvent,
	LineMessageEvent,
	LineSubscriber,
	LineUnsentEvent,
} from "../messages.ts";
import { body, messageEvent } from "./line-fake.ts";
import { freshPool, truncateAll } from "./pool.ts";

export const TIME = new Date("2026-10-13T00:00:00Z");

export const enc = (value: string) => new TextEncoder().encode(value);

export const refsOf = (event: LineEvent | undefined): readonly string[] =>
	(event as LineUnsentEvent).refs;

export const unsendEvent = (
	messageId: string,
	id: string,
	timestamp: number,
): Record<string, unknown> => ({
	type: "unsend",
	mode: "active",
	timestamp,
	webhookEventId: id,
	source: { type: "group", groupId: "Cgroup0001", userId: "Uuser0001" },
	unsend: { messageId },
});

export const editEvent = (
	messageId: string,
	id: string,
	timestamp: number,
	text: string,
): Record<string, unknown> => ({
	...messageEvent({ id, timestamp, messageId, type: "messageEdited", text }),
	message: { id: messageId, type: "text", text, quoteToken: `quote-${id}` },
});

export const plainEvent = (
	type: string,
	extra: Record<string, unknown> = {},
	id = `${type}-1`,
): Record<string, unknown> => ({
	type,
	mode: "active",
	timestamp: 1_700_000_005_000,
	webhookEventId: id,
	source: { type: "group", groupId: "Cgroup0001" },
	replyToken: `reply-${id}`,
	...extra,
});

export let sql: SQL;

export const logs = recordingLogger();

export const events: LineEvent[] = [];

/** What the stub subscriber does: `answer` for a message (default two refs named after it), and an error `failNext` for the next event. */
export const subscriber: {
	answer: (event: LineMessageEvent, context: LineContext) => Promise<unknown>;
	failNext: Error | undefined;
} = {
	answer: async (event) => ({
		refs: [`post-${event.messageId}-1`, `post-${event.messageId}-2`],
	}),
	failNext: undefined,
};

export let consumer: LineConsumer;

export let process: InboxProcessor;

export const inbox = async (
	raw: Record<string, unknown>,
	attempt = 1,
): Promise<InboxEvent> => {
	const [parsed] = (await parseWebhook(enc(body(raw)))).events;
	if (!parsed) throw new Error("no event");
	return {
		id: parsed.id,
		type: parsed.type,
		sourceKey: parsed.sourceKey,
		messageId: parsed.messageId,
		timestamp: parsed.timestamp,
		payload: parsed.raw,
		attempt,
	};
};

export const run = async (raw: Record<string, unknown>) =>
	process(await inbox(raw), new AbortController().signal);

export const types = () => events.map((e) => e.type);

export const rows = async (table: string) =>
	sql.unsafe(`SELECT * FROM ${table} ORDER BY 1, 2, 3`) as Promise<
		Record<string, unknown>[]
	>;

/** The rows without their creation time, which these tests fix anyway. */
export const bare = async (table: string) =>
	(await rows(table)).map(({ created_at: _, ...rest }) => rest);

export function useConsumerHarness() {
	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		events.length = 0;
		subscriber.failNext = undefined;
		logs.lines.length = 0;
		subscriber.answer = async (event) => ({
			refs: [`post-${event.messageId}-1`, `post-${event.messageId}-2`],
		});
		consumer = new LineConsumer({ sql, logger: logs.logger, now: () => TIME });
		process = consumer.processorFor(async (event, _signal, context) => {
			events.push(event);
			if (subscriber.failNext) {
				const error = subscriber.failNext;
				subscriber.failNext = undefined;
				throw error;
			}
			if (event.type === "message")
				return subscriber.answer(event, context) as ReturnType<LineSubscriber>;
			return undefined;
		});
	});

	afterAll(async () => {
		await sql?.close();
		// The next file opens its own pool.
		sql = undefined as never;
	});
}
