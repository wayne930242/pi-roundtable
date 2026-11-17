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
	const left = new Set<string>();
	const state = { failClaims: false };
	const journal: InboundJournal = {
		claim: async ({ messageId }) => {
			if (state.failClaims) throw new Error("database down");
			if (left.delete(messageId)) return true;
			if (rows.has(messageId)) return false;
			rows.add(messageId);
			return true;
		},
		leave: async ({ messageId }) => {
			rows.add(messageId);
			left.add(messageId);
		},
		leaveNew: async ({ messageId }) => {
			if (rows.has(messageId)) return false;
			rows.add(messageId);
			left.add(messageId);
			return true;
		},
		left: async () => [],
		recordedAmong: async (_bot, ids) =>
			new Set(ids.filter((id) => rows.has(id))),
		directChannels: async () => [],
		prune: async () => undefined,
	};
	return { journal, rows, left, state };
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

test("a recorded message routing refuses as the host stops is left for the next process and its channel told so, once; any other gets one recorded notice to send it again", async () => {
	const { journal, rows, left } = memoryJournal();
	const told = notices();
	const gate = journalGate({
		journal,
		logger: silentLogger(),
		notify: told.notify,
	});
	expect(await gate(message("m1"), "9")).toBe(true);
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
	expect([...left]).toEqual(["m1", "m2"]);
	expect(told.posted).toEqual([
		["notice-1", "later"],
		["notice-2", "resend"],
	]);
	expect([...rows].toSorted()).toEqual(["m1", "m2", "notice-1", "notice-2"]);
});

test("a drain-time message routing never refuses is promised nothing and not left, as nothing would answer it", async () => {
	const { journal, rows, left } = memoryJournal();
	const told = notices();
	const gate = journalGate({
		journal,
		logger: silentLogger(),
		draining: () => true,
		notify: told.notify,
	});
	// Routing hears it, and drops it in a channel no claim serves.
	expect(await gate(message("m1"), "9")).toBe(true);
	expect([...left]).toEqual([]);
	expect([...rows]).toEqual([]);
	expect(told.posted).toEqual([]);
	// One routing refuses because the host stops is left, and its channel told so.
	expect(await gate(message("m2"), "9")).toBe(true);
	expect(await gate.refused(message("m2"), "9")).toBe(true);
	expect([...left]).toEqual(["m2"]);
	expect(told.posted).toEqual([["notice-1", "later"]]);
});

test("a drain-time message that cannot be left gets no notice, since catch-up answers it from its unrecorded place in the window", async () => {
	const { journal } = memoryJournal();
	const told = notices();
	const gate = journalGate({
		journal: {
			...journal,
			leaveNew: async () => {
				throw new Error("database down");
			},
		},
		logger: silentLogger(),
		draining: () => true,
		notify: told.notify,
	});
	expect(await gate(message("m1"), "9")).toBe(true);
	expect(await gate.refused(message("m1"), "9")).toBe(true);
	expect(told.posted).toEqual([]);
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
	expect(await gate(message("m1"), "9")).toBe(true);
	expect(await gate.refused(message("m1"), "9")).toBe(true);
	expect(told.retracted).toEqual(["notice-1"]);
});

test("a message another process recorded first is claimed once more off the channel's chain, so one that process left on its drain is still answered", async () => {
	const { journal, rows, left } = memoryJournal();
	rows.add("m1");
	rows.add("m2");
	const redelivered: string[] = [];
	const gate = journalGate({
		journal,
		logger: silentLogger(),
		retryMs: 10,
		redeliver: (m) => redelivered.push(`${m.messageId} ${m.caughtUp}`),
	});
	expect(await gate(message("m1"), "9")).toBe(false);
	expect(await gate(message("m2"), "9")).toBe(false);
	left.add("m1");
	await Bun.sleep(30);
	expect(redelivered).toEqual(["m1 true"]);
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
		message: async () => undefined,
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

test("a draining process leaves alone a message another process already took in, and tells no one", async () => {
	const { journal, rows, left } = memoryJournal();
	rows.add("m1");
	const told = notices();
	const gate = journalGate({
		journal,
		logger: silentLogger(),
		draining: () => true,
		notify: told.notify,
	});
	expect(await gate(message("m1"), "9")).toBe(true);
	expect(await gate.refused(message("m1"), "9")).toBe(true);
	expect(left.has("m1")).toBe(false);
	expect(told.posted).toEqual([]);
	expect(await gate(message("m2"), "9")).toBe(true);
	expect(await gate.refused(message("m2"), "9")).toBe(true);
	expect(left.has("m2")).toBe(true);
	expect(told.posted).toEqual([["notice-1", "later"]]);
});

test("a message the retry took but could not deliver is left again for a later process", async () => {
	const { journal, rows, left } = memoryJournal();
	rows.add("m1");
	const gate = journalGate({
		journal,
		logger: silentLogger(),
		retryMs: 5,
		redeliver: () => {
			throw new Error("routing gone");
		},
	});
	expect(await gate(message("m1"), "9")).toBe(false);
	left.add("m1");
	await Bun.sleep(20);
	expect(left.has("m1")).toBe(true);
});
