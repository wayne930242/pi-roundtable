import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { InboundMessage } from "../contract/channels.ts";
import { ConfigError } from "../domain/errors.ts";
import { silentLogger } from "../kernel/log.ts";
import { describeDb, migratedPool } from "../testing/database.ts";
import {
	type CatchUpChannel,
	type CatchUpReader,
	catchUp,
	catchUpSettings,
	journalGate,
	type ScannedMessage,
	snowflakeAt,
} from "./catch-up.ts";
import { type InboundJournal, PgInboundJournal } from "./catch-up-journal.ts";

const MINUTE = 60_000;
const READY = Date.parse("2026-11-17T07:00:00Z");
const PERSON = "100000000000000001";

/** A bot of its own per run, so rows an earlier run left in the shared table do not count. */
const botOf = () =>
	`9${String(Math.floor(Math.random() * 1e15)).padStart(17, "0")}`;

let sequence = 0n;
/** A message posted `minutesBefore` the ready time, a person's mentioning nobody unless told. */
function posted(
	minutesBefore: number,
	extra: Partial<ScannedMessage> = {},
): ScannedMessage {
	const at = READY - minutesBefore * MINUTE;
	sequence += 1n;
	return {
		id: (BigInt(snowflakeAt(at)) + sequence).toString(),
		createdTimestamp: at,
		author: { id: PERSON, bot: false },
		webhookId: null,
		applicationId: null,
		system: false,
		mentions: { users: new Set<string>(), repliedUser: null },
		...extra,
	};
}

const mention = (bot: string) => ({
	mentions: { users: new Set([bot]), repliedUser: null },
});

/** A channel holding `messages`; it reads them as Discord does, before a snowflake, newest first. */
function channelOf(
	id: string,
	messages: ScannedMessage[],
	direct = false,
): CatchUpChannel<ScannedMessage> & { reads: number } {
	const view = {
		id,
		direct,
		reads: 0,
		lastMessageAt:
			Math.max(0, ...messages.map((m) => m.createdTimestamp)) || undefined,
		read: async (before: string, limit: number) => {
			view.reads += 1;
			return messages
				.filter((m) => BigInt(m.id) < BigInt(before))
				.toSorted((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
				.slice(0, limit);
		},
	};
	return view;
}

function readerOf(
	bot: string,
	channels: CatchUpChannel<ScannedMessage>[],
	directs: CatchUpChannel<ScannedMessage>[] = [],
	readyAt = READY,
): CatchUpReader<ScannedMessage> {
	return {
		botId: bot,
		applicationId: undefined,
		readyAt,
		channels: () => [...channels],
		direct: async (id) => directs.find((channel) => channel.id === id),
		inbound: async (message) => ({
			channel: "discord:700000000000000000",
			messageId: message.id,
			authorId: message.author.id,
			authorName: "Ada",
			authorIsBot: message.author.bot,
			isDirect: false,
			mentionsBot: message.mentions.users.has(bot),
			repliesToBot: message.mentions.repliedUser?.id === bot,
			text: `message ${message.id}`,
			attachments: [],
		}),
	};
}

const settings = catchUpSettings({});

describeDb("catch-up over the journal", () => {
	let sql: SQL;
	let journal: InboundJournal;

	beforeAll(async () => {
		sql = await migratedPool(PgInboundJournal.migration);
		journal = PgInboundJournal.attach(sql);
	});

	afterAll(async () => {
		await sql.close();
	});

	const run = async (reader: CatchUpReader<ScannedMessage>, max = settings) => {
		const delivered: InboundMessage[] = [];
		const report = await catchUp({
			reader,
			journal,
			deliver: (message) => delivered.push(message),
			settings: max,
			logger: silentLogger(),
			now: () => READY,
		});
		return { delivered, report };
	};

	test("a mention missed while the host was down is answered once, marked caught up; the next restart leaves it", async () => {
		const bot = botOf();
		const missed = posted(2, mention(bot));
		const channel = channelOf("700000000000000001", [missed]);
		const first = await run(readerOf(bot, [channel]));
		expect(first.delivered.map((m) => [m.messageId, m.caughtUp])).toEqual([
			[missed.id, true],
		]);
		// The second restart: a fresh journal over the same table, the same message still unanswered.
		journal = PgInboundJournal.attach(sql);
		const second = await run(readerOf(bot, [channel], [], READY + 5 * MINUTE));
		expect(second.delivered).toEqual([]);
		expect(second.report.handled).toBe(1);
	});

	test("a message older than the window is not read for, nor answered", async () => {
		const bot = botOf();
		const old = channelOf("700000000000000002", [posted(30, mention(bot))]);
		const mixed = channelOf("700000000000000003", [
			posted(11, mention(bot)),
			posted(1, { author: { id: PERSON, bot: false } }),
		]);
		const { delivered, report } = await run(readerOf(bot, [old, mixed]));
		expect(delivered).toEqual([]);
		expect(old.reads).toBe(0);
		expect(report.missed).toBe(0);
	});

	test("a message the bot answered before the restart, or one its own webhook answered, is not answered again", async () => {
		const bot = botOf();
		const answered = channelOf("700000000000000004", [
			posted(5, mention(bot)),
			posted(4, { author: { id: bot, bot: true } }),
		]);
		const byAgent = channelOf("700000000000000005", [
			posted(5, mention(bot)),
			posted(4, {
				author: { id: "800000000000000009", bot: true },
				webhookId: "600000000000000001",
				applicationId: bot,
			}),
		]);
		const { delivered, report } = await run(readerOf(bot, [answered, byAgent]));
		expect(delivered).toEqual([]);
		expect(report.replied).toBe(2);
	});

	test("a message the live gateway took in before the restart is not answered again", async () => {
		const bot = botOf();
		const live = posted(3, mention(bot));
		const channel = channelOf("700000000000000006", [live]);
		const reader = readerOf(bot, [channel]);
		const inbound = await reader.inbound(live);
		expect(
			inbound &&
				(await journalGate({ journal, logger: silentLogger() })(inbound, bot)),
		).toBe(true);
		const { delivered, report } = await run(reader);
		expect(delivered).toEqual([]);
		expect(report.handled).toBe(1);
	});

	test("a message catch-up delivered is refused if the gateway delivers it too", async () => {
		const bot = botOf();
		const missed = posted(1, mention(bot));
		const reader = readerOf(bot, [channelOf("700000000000000007", [missed])]);
		expect((await run(reader)).delivered).toHaveLength(1);
		const inbound = await reader.inbound(missed);
		expect(
			inbound &&
				(await journalGate({ journal, logger: silentLogger() })(inbound, bot)),
		).toBe(false);
	});

	test("only a person's mention, reply to the bot or direct message counts; bots, webhooks and system messages do not", async () => {
		const bot = botOf();
		const reply = posted(6, {
			mentions: { users: new Set(), repliedUser: { id: bot } },
		});
		const channel = channelOf("700000000000000008", [
			posted(7, {
				mentions: { users: new Set([bot]), repliedUser: null },
				author: { id: "800000000000000001", bot: true },
			}),
			posted(7, { ...mention(bot), webhookId: "600000000000000002" }),
			posted(7, { ...mention(bot), system: true }),
			posted(7),
			reply,
		]);
		const dm = posted(2);
		const direct = channelOf("700000000000000009", [dm], true);
		await journal.claim({
			botId: bot,
			messageId: "1",
			channelId: direct.id,
			direct: true,
		});
		const { delivered } = await run(readerOf(bot, [channel], [direct]));
		expect(delivered.map((m) => m.messageId)).toEqual([reply.id, dm.id]);
	});

	test("over the cap, the newest are answered, oldest first", async () => {
		const bot = botOf();
		const messages = [9, 7, 5, 3, 1].map((minutes) =>
			posted(minutes, mention(bot)),
		);
		const one = channelOf("700000000000000010", messages.slice(0, 2));
		const two = channelOf("700000000000000011", messages.slice(2));
		const { delivered, report } = await run(
			readerOf(bot, [one, two]),
			catchUpSettings({ maxMessages: 3 }),
		);
		expect(delivered.map((m) => m.messageId)).toEqual(
			messages.slice(2).map((m) => m.id),
		);
		expect(report.overCap).toBe(2);
	});

	test("a message that cannot be recorded is not answered, since it could be answered twice", async () => {
		const bot = botOf();
		const broken: InboundJournal = {
			claim: async () => {
				throw new Error("database down");
			},
			directChannels: async () => [],
			prune: async () => undefined,
			release: async () => undefined,
			recordedAmong: async () => new Set(),
		};
		const delivered: InboundMessage[] = [];
		const report = await catchUp({
			reader: readerOf(bot, [
				channelOf("700000000000000012", [posted(1, mention(bot))]),
			]),
			journal: broken,
			deliver: (message) => delivered.push(message),
			settings,
			logger: silentLogger(),
		});
		expect(delivered).toEqual([]);
		expect(report.failed).toBe(1);
		// The live gateway still delivers what it cannot record.
		const inbound = await readerOf(bot, []).inbound(posted(0, mention(bot)));
		expect(
			inbound &&
				(await journalGate({ journal: broken, logger: silentLogger() })(
					inbound,
					bot,
				)),
		).toBe(true);
	});

	test("a restart notice the bot recorded as it shut down is no answer: the mention before it is answered", async () => {
		const bot = botOf();
		const missed = posted(4, mention(bot));
		const notice = posted(3, { author: { id: bot, bot: true } });
		const later = posted(2, mention(bot));
		await journal.claim({
			botId: bot,
			messageId: notice.id,
			channelId: "700000000000000013",
			direct: false,
		});
		const { delivered, report } = await run(
			readerOf(bot, [channelOf("700000000000000013", [missed, notice, later])]),
		);
		expect(delivered.map((m) => m.messageId)).toEqual([missed.id, later.id]);
		expect(report.replied).toBe(0);
	});

	test("a message recorded as the host begins to stop is released, not delivered, so the next process answers it", async () => {
		const bot = botOf();
		const missed = posted(1, mention(bot));
		const reader = readerOf(bot, [channelOf("700000000000000014", [missed])]);
		let stopping = false;
		const delivered: InboundMessage[] = [];
		const claiming = journal.claim.bind(journal);
		const report = await catchUp({
			reader,
			journal: {
				...journal,
				claim: async (entry) => {
					const first = await claiming(entry);
					stopping = true;
					return first;
				},
			},
			deliver: (message) => delivered.push(message),
			settings,
			logger: silentLogger(),
			stopping: () => stopping,
		});
		expect(delivered).toEqual([]);
		expect(report.delivered).toBe(0);
		expect((await run(reader)).delivered.map((m) => m.messageId)).toEqual([
			missed.id,
		]);
	});

	test("the gate releases a message recorded as the drain began, and tells its channel once, recording the notice", async () => {
		const bot = botOf();
		const missed = posted(1, mention(bot));
		const reader = readerOf(bot, [channelOf("700000000000000015", [missed])]);
		const inbound = await reader.inbound(missed);
		let draining = false;
		const claiming = journal.claim.bind(journal);
		const notices: string[] = [];
		const notice = posted(0.5, { author: { id: bot, bot: true } });
		const gate = journalGate({
			journal: {
				...journal,
				claim: async (entry) => {
					const first = await claiming(entry);
					draining = true;
					return first;
				},
			},
			logger: silentLogger(),
			draining: () => draining,
			notify: async (channelId) => {
				notices.push(channelId);
				return notice.id;
			},
		});
		expect(inbound && (await gate(inbound, bot))).toBe(false);
		expect(inbound && (await gate({ ...inbound, messageId: "5" }, bot))).toBe(
			false,
		);
		expect(notices).toEqual(["700000000000000000"]);
		expect(await journal.recordedAmong(bot, [notice.id, missed.id])).toEqual(
			new Set([notice.id]),
		);
		expect((await run(reader)).delivered.map((m) => m.messageId)).toEqual([
			missed.id,
		]);
	});

	test("a message the live gateway delivered without a record in this process is not caught up again", async () => {
		const bot = botOf();
		const missed = posted(1, mention(bot));
		const reader = readerOf(bot, [channelOf("700000000000000016", [missed])]);
		const unrecorded = new Set<string>();
		const inbound = await reader.inbound(missed);
		const gate = journalGate({
			journal: {
				...journal,
				claim: async () => {
					throw new Error("database down");
				},
			},
			logger: silentLogger(),
			unrecorded,
		});
		expect(inbound && (await gate(inbound, bot))).toBe(true);
		expect([...unrecorded]).toEqual([missed.id]);
		const delivered: InboundMessage[] = [];
		const report = await catchUp({
			reader,
			journal,
			deliver: (message) => delivered.push(message),
			settings,
			logger: silentLogger(),
			passedLive: (id) => unrecorded.has(id),
		});
		expect(delivered).toEqual([]);
		expect(report.handled).toBe(1);
	});

	test("the journal forgets what is older than it keeps", async () => {
		const bot = botOf();
		await journal.claim({
			botId: bot,
			messageId: "11",
			channelId: "1",
			direct: false,
		});
		await journal.prune(new Date(Date.now() + 60_000));
		expect(await journal.recordedAmong(bot, ["11"])).toEqual(new Set());
	});

	test("a mention with a thread started from it, or a reaction of the bot's, was answered before the restart", async () => {
		const bot = botOf();
		const threaded = posted(4, { ...mention(bot), hasThread: true });
		const reacted = posted(3, {
			...mention(bot),
			reactions: { cache: [{ me: false }, { me: true }] },
		});
		const othersReaction = posted(2, {
			...mention(bot),
			reactions: { cache: [{ me: false }] },
		});
		const { delivered, report } = await run(
			readerOf(bot, [
				channelOf("700000000000000017", [threaded, reacted, othersReaction]),
			]),
		);
		expect(delivered.map((m) => m.messageId)).toEqual([othersReaction.id]);
		expect(report.replied).toBe(2);
	});
});

test("a message not addressed to the bot passes the gate unrecorded; while the host drains, an addressed one is held back unrecorded", async () => {
	const claimed: string[] = [];
	const journal: InboundJournal = {
		claim: async ({ messageId }) => {
			claimed.push(messageId);
			return false;
		},
		directChannels: async () => [],
		prune: async () => undefined,
		release: async () => undefined,
		recordedAmong: async () => new Set(),
	};
	const message = {
		channel: "discord:1",
		messageId: "2",
		authorId: PERSON,
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		mentionsBot: false,
		repliesToBot: false,
		text: "hi",
		attachments: [],
	} satisfies InboundMessage;
	expect(
		await journalGate({ journal, logger: silentLogger() })(message, "9"),
	).toBe(true);
	// Once the host drains, an addressed message is not routed nor recorded, so the next process answers it.
	const addressedMessage = { ...message, mentionsBot: true };
	expect(
		await journalGate({
			journal,
			logger: silentLogger(),
			draining: () => true,
		})(addressedMessage, "9"),
	).toBe(false);
	expect(claimed).toEqual([]);
	expect(
		await journalGate({ journal, logger: silentLogger() })(
			addressedMessage,
			"9",
		),
	).toBe(false);
	expect(claimed).toEqual(["2"]);
});

test("catch-up settings fill the defaults and refuse what the config file refuses", () => {
	expect(catchUpSettings({})).toEqual({ windowMinutes: 10, maxMessages: 20 });
	expect(() => catchUpSettings({ windowMinutes: 0 })).toThrow(ConfigError);
	expect(() => catchUpSettings({ windowMinutes: 1441 })).toThrow(ConfigError);
	expect(() => catchUpSettings({ maxMessages: 1.5 })).toThrow(ConfigError);
	expect(() => catchUpSettings({ maxMessages: 101 })).toThrow(ConfigError);
});
