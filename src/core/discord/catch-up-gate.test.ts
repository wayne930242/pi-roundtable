import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import { silentLogger } from "../kernel/log.ts";
import {
	type CatchUpReader,
	catchUp,
	catchUpSettings,
	type ScannedMessage,
	snowflakeAt,
} from "./catch-up.ts";
import { journalGate, type NoticeKind } from "./catch-up-gate.ts";
import type { InboundJournal } from "./catch-up-journal.ts";

/** A journal in memory, whose claims may fail on demand. */
function memoryJournal() {
	const rows = new Set<string>();
	const state = { failClaims: false };
	const journal: InboundJournal = {
		claim: async ({ messageId }) => {
			if (state.failClaims) throw new Error("database down");
			if (rows.has(messageId)) return false;
			rows.add(messageId);
			return true;
		},
		release: async (_bot, messageId) => void rows.delete(messageId),
		recordedAmong: async (_bot, ids) =>
			new Set(ids.filter((id) => rows.has(id))),
		directChannels: async () => [],
		prune: async () => undefined,
	};
	return { journal, rows, state };
}

const message = (id: string, extra: Partial<InboundMessage> = {}) =>
	({
		channel: "discord:5",
		messageId: id,
		authorId: "1",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		mentionsBot: true,
		repliesToBot: false,
		text: id,
		attachments: [],
		...extra,
	}) satisfies InboundMessage;

function notices() {
	const posted: [string, NoticeKind][] = [];
	const retracted: string[] = [];
	let next = 0;
	return {
		posted,
		retracted,
		notify: async (channelId: string, kind: NoticeKind) => {
			next += 1;
			const id = `notice-${next}`;
			posted.push([id, kind]);
			return { id, retract: async () => void retracted.push(id) };
		},
	};
}

test("a recorded message routing refuses as the host stops is released and its channel told it is answered later, once; any other gets one recorded notice to send it again", async () => {
	const { journal, rows } = memoryJournal();
	const told = notices();
	const gate = journalGate({
		journal,
		logger: silentLogger(),
		notify: told.notify,
	});
	expect(await gate(message("m1"), "9")).toBe(true);
	expect(rows.has("m1")).toBe(true);
	expect(await gate.refused(message("m1"), "9")).toBe(true);
	expect(await gate.refused(message("m2"), "9")).toBe(true);
	expect(await gate.refused(message("x", { mentionsBot: false }), "9")).toBe(
		true,
	);
	expect(await gate.refused(message("y", { mentionsBot: false }), "9")).toBe(
		true,
	);
	expect(await gate.refused(message("b", { authorIsBot: true }), "9")).toBe(
		false,
	);
	expect(rows.has("m1")).toBe(false);
	expect(told.posted).toEqual([
		["notice-1", "later"],
		["notice-2", "resend"],
	]);
	expect([...rows]).toEqual(["notice-1", "notice-2"]);
});

test("a notice that cannot be recorded is deleted again, so catch-up never takes it for an answer", async () => {
	const { journal, state } = memoryJournal();
	const told = notices();
	const gate = journalGate({
		journal,
		logger: silentLogger(),
		draining: () => true,
		notify: told.notify,
	});
	state.failClaims = true;
	expect(await gate(message("m1"), "9")).toBe(false);
	expect(told.retracted).toEqual(["notice-1"]);
});

test("a message another process recorded first is claimed once more after a while, so one that process released on its drain is still answered", async () => {
	const { journal, rows } = memoryJournal();
	rows.add("m1");
	const gate = journalGate({ journal, logger: silentLogger(), retryMs: 10 });
	const passing = gate(message("m1"), "9");
	rows.delete("m1");
	expect(await passing).toBe(true);
	rows.add("m2");
	expect(await gate(message("m2"), "9")).toBe(false);
});

const READY = Date.parse("2026-11-17T07:00:00Z");

/** A reader over one server channel holding a mention and a later post of the bot's, and one remembered direct message. */
function readerWith(events: string[]): CatchUpReader<ScannedMessage> {
	const at = READY - 60_000;
	const mention: ScannedMessage = {
		id: (BigInt(snowflakeAt(at)) + 1n).toString(),
		createdTimestamp: at,
		author: { id: "1", bot: false },
		webhookId: null,
		applicationId: null,
		system: false,
		mentions: { users: new Set(["9"]), repliedUser: null },
	};
	const post: ScannedMessage = {
		...mention,
		id: (BigInt(snowflakeAt(at + 1000)) + 1n).toString(),
		createdTimestamp: at + 1000,
		author: { id: "9", bot: true },
	};
	return {
		botId: "9",
		applicationId: undefined,
		readyAt: READY,
		channels: () => [
			{
				id: "5",
				direct: false,
				lastMessageAt: at,
				read: async () => [post, mention],
			},
		],
		direct: async (id) => {
			events.push(`fetch ${id}`);
			return undefined;
		},
		inbound: async (m) => message(m.id),
	};
}

test("when catch-up cannot tell its restart notices, it leaves the channel unread rather than take one for an answer; it plans its channels before fetching direct messages", async () => {
	const { journal } = memoryJournal();
	const events: string[] = [];
	const delivered: string[] = [];
	const report = await catchUp({
		reader: readerWith(events),
		journal: {
			...journal,
			directChannels: async () => ["77"],
			recordedAmong: async () => {
				throw new Error("database down");
			},
		},
		deliver: (m) => delivered.push(m.messageId),
		settings: catchUpSettings({}),
		logger: silentLogger(),
		planned: (ids) => events.push(`plan ${ids.join(",")}`),
		now: () => READY,
	});
	expect(events).toEqual(["plan 5,77", "fetch 77"]);
	expect(report.unread).toBe(1);
	expect(report.replied).toBe(0);
	expect(delivered).toEqual([]);
});
