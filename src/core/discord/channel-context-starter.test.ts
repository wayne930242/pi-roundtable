import { expect, test } from "bun:test";
import { ChannelType, DiscordAPIError } from "discord.js";
import type { InboundMessage } from "../contract/channels.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import {
	ChannelContextReader,
	type ContextSourceMessage,
	selectChannelContext,
} from "./channel-context.ts";
import { DiscordSurface } from "./discord-surface.ts";

const OWNER = "100";
const THREAD = "77";
const STARTER = THREAD;

let clock = 1_000;
function source(
	id: string,
	text: string,
	extra: Partial<ContextSourceMessage> = {},
): ContextSourceMessage {
	clock += 1_000;
	return {
		id,
		authorId: "200",
		authorName: "Kai",
		bot: false,
		own: false,
		at: clock,
		text,
		...extra,
	};
}

function inbound(extra: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: `discord:${THREAD}`,
		messageId: "50",
		authorId: OWNER,
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		space: "g1",
		mentionsBot: true,
		repliesToBot: false,
		text: "what do you think?",
		attachments: [],
		...extra,
	};
}

const SETTINGS = {
	fetch: 50,
	keep: 2,
	similarity: 0.8,
	messageChars: 20,
	botMessageChars: 80,
	foreignWebhook: () => false,
};

function select(
	fetched: ContextSourceMessage[],
	starter: ContextSourceMessage | undefined,
	seen: ReadonlySet<string> = new Set(),
	settings: Parameters<typeof selectChannelContext>[1]["settings"] = SETTINGS,
) {
	return selectChannelContext(fetched, {
		seen,
		owners: [OWNER],
		settings,
		...(starter ? { starter } : {}),
	});
}

// Selection ------------------------------------------------------------------------------------

test("a starter outside the fetched window comes first, oldest first, outside keep, cut like a message", () => {
	const opening = source(STARTER, "the post that opened this thread, long");
	const fetched = [source("1", "a"), source("2", "b"), source("3", "c")];
	const { messages } = select(fetched, opening);
	expect(messages.map((m) => m.id)).toEqual([STARTER, "2", "3"]);
	expect(messages[0]?.text).toBe("the post that opened…");
});

test("a starter the window holds is not repeated, and stays when keep or the assistant's last post would drop it", () => {
	const opening = source(STARTER, "opening");
	const fetched = [
		opening,
		source("2", "answer", { own: true, authorId: "900" }),
		source("3", "after"),
	];
	// The assistant's post ends the window after the starter; the starter stays, once.
	expect(select(fetched, opening).messages.map((m) => m.id)).toEqual([
		STARTER,
		"3",
	]);
	// Without the option, the window drops it.
	expect(select(fetched, undefined).messages.map((m) => m.id)).toEqual(["3"]);
	// keep crowds it out of the window; it is outside keep.
	const crowded = [
		opening,
		source("2", "b"),
		source("3", "c"),
		source("4", "d"),
	];
	expect(select(crowded, opening).messages.map((m) => m.id)).toEqual([
		STARTER,
		"3",
		"4",
	]);
});

test("the starter passes the filters of every message: authors, empty text, the assistant's own, delivered before", () => {
	const opening = source(STARTER, "opening");
	const fetched = [source("2", "b")];
	const ids = (
		starter: ContextSourceMessage,
		seen = new Set<string>(),
		authors?: never,
	) =>
		select(fetched, starter, seen, {
			...SETTINGS,
			...(authors ? { authors } : {}),
		}).messages.map((m) => m.id);
	expect(ids(opening)).toEqual([STARTER, "2"]);
	expect(ids(source(STARTER, ""))).toEqual(["2"]);
	expect(ids(source(STARTER, "mine", { own: true, authorId: "900" }))).toEqual([
		"2",
	]);
	expect(ids(opening, new Set([STARTER]))).toEqual(["2"]);
	const skipped = select(fetched, opening, new Set(), {
		...SETTINGS,
		authors: (m) => (m.id === STARTER ? "skip" : undefined),
	});
	expect(skipped.messages.map((m) => m.id)).toEqual(["2"]);
	const ended = select(fetched, opening, new Set(), {
		...SETTINGS,
		authors: (m) => (m.id === STARTER ? "end" : undefined),
	});
	expect(ended.messages.map((m) => m.id)).toEqual(["2"]);
	const kept = select(
		fetched,
		source(STARTER, "mine", { own: true }),
		new Set(),
		{
			...SETTINGS,
			authors: () => "keep",
		},
	);
	expect(kept.messages.map((m) => m.id)).toEqual([STARTER, "2"]);
});

// Reader ---------------------------------------------------------------------------------------

function reader(
	options: {
		fetched?: ContextSourceMessage[];
		starter?: (channelId: string) => Promise<ContextSourceMessage | undefined>;
		settings?: ConstructorParameters<
			typeof ChannelContextReader
		>[0]["settings"];
	} = {},
) {
	const recorded = recordingLogger();
	return {
		lines: recorded.lines,
		reader: new ChannelContextReader({
			read: async () => options.fetched ?? [],
			owners: async () => [OWNER],
			...(options.starter ? { starter: options.starter } : {}),
			settings: options.settings ?? {},
			logger: recorded.logger,
		}),
	};
}

test("CONTRACT: starter: true brings in the opening message outside the window; without it the context is as before", async () => {
	const opening = source(STARTER, "forum post body");
	const asked: string[] = [];
	const starter = async (channelId: string) => {
		asked.push(channelId);
		return opening;
	};
	const fetched = [source("20", "reply one"), source("21", "reply two")];
	const without = reader({ fetched, starter });
	expect(
		(await without.reader.of(inbound()))?.messages.map((m) => m.id),
	).toEqual(["20", "21"]);
	expect(asked).toEqual([]);

	const withIt = reader({ fetched, starter });
	const got = await withIt.reader.of(inbound(), { starter: true });
	expect(got?.messages.map((m) => m.id)).toEqual([STARTER, "20", "21"]);
	expect(got?.text).toContain("forum post body");
	expect(asked).toEqual([THREAD]);
	// Handed over once: the next turn does not repeat it.
	const next = await withIt.reader.of(inbound({ messageId: "60" }), {
		starter: true,
	});
	expect(next).toBeUndefined();
});

test("starter on the host's settings applies to every call; a call can switch it off", async () => {
	const opening = source(STARTER, "post");
	const { reader: r } = reader({
		starter: async () => opening,
		settings: { starter: true },
	});
	expect(await r.of(inbound(), { starter: false })).toBeUndefined();
	expect(
		(await r.of(inbound({ messageId: "51" })))?.messages.map((m) => m.id),
	).toEqual([STARTER]);
});

test("a thread with only its starter still has a context; the addressed message is never its own starter", async () => {
	const opening = source(STARTER, "post");
	const only = reader({ starter: async () => opening });
	expect(
		(await only.reader.of(inbound(), { starter: true }))?.messages.map(
			(m) => m.id,
		),
	).toEqual([STARTER]);
	const self = reader({ starter: async () => opening });
	expect(
		await self.reader.of(inbound({ messageId: STARTER }), { starter: true }),
	).toBeUndefined();
});

test("a starter that is gone, absent or unreadable adds nothing and never fails the turn", async () => {
	const fetched = [source("20", "reply")];
	for (const starter of [
		async () => undefined,
		async () => {
			throw new Error("Discord refused");
		},
	]) {
		const { reader: r, lines } = reader({ fetched, starter });
		expect(
			(await r.of(inbound(), { starter: true }))?.messages.map((m) => m.id),
		).toEqual(["20"]);
		expect(lines.filter((l) => l.level === "warn")).toEqual([]);
	}
	// A reader whose host gave no starter lookup reads as before.
	const bare = reader({ fetched });
	expect(
		(await bare.reader.of(inbound(), { starter: true }))?.messages.map(
			(m) => m.id,
		),
	).toEqual(["20"]);
});

test("starter must be a boolean", async () => {
	const { reader: r } = reader();
	await expect(r.of(inbound(), { starter: "yes" as never })).rejects.toThrow(
		"channel context option starter must be a boolean",
	);
});

// The real adapter -----------------------------------------------------------------------------

/** A discord.js message as `contextSourceOf` reads it. */
function discordMessage(id: string, content: string) {
	return {
		id,
		content,
		createdTimestamp: Number(id),
		author: { id: "200", bot: false, username: "kai", globalName: "Kai" },
		member: null,
		webhookId: null,
		applicationId: null,
		mentions: { users: new Map(), members: new Map() },
		stickers: new Map(),
		embeds: [],
		attachments: new Map(),
	};
}

function missing(code: number): DiscordAPIError {
	return new DiscordAPIError(
		{ message: "Unknown", code },
		code,
		404,
		"GET",
		"/x",
		{},
	);
}

/** A surface over a real discord.js client whose channel lookup answers with `channel`. */
function surfaceWith(channel: unknown) {
	const surface = new DiscordSurface({
		token: "token",
		ownerId: OWNER,
		ownerName: "Ada",
		prompts: () => undefined,
		logger: recordingLogger().logger,
	});
	const client = surface.client();
	Object.defineProperty(client, "isReady", { value: () => true });
	Object.defineProperty(client, "user", { value: { id: "900" } });
	Object.defineProperty(client, "application", { value: { id: "app" } });
	client.channels.fetch = (async () => channel) as never;
	return surface;
}

function thread(
	parentType: ChannelType,
	fetchStarterMessage: () => Promise<unknown>,
) {
	return {
		type: ChannelType.PublicThread,
		parent: { type: parentType },
		isThread: () => true,
		isTextBased: () => true,
		isDMBased: () => false,
		fetchStarterMessage,
	};
}

test("REAL ADAPTER: a forum post's and a text thread's starter read as channel context sources", async () => {
	for (const parent of [ChannelType.GuildForum, ChannelType.GuildText]) {
		const surface = surfaceWith(
			thread(parent, async () => discordMessage(STARTER, "the opening")),
		);
		expect(await surface.threadStarter(THREAD)).toMatchObject({
			id: STARTER,
			text: "the opening",
			own: false,
		});
	}
});

test("REAL ADAPTER: no starter for a deleted one, a channel that is not a thread, or a null", async () => {
	const deleted = surfaceWith(
		thread(ChannelType.GuildText, async () => {
			throw missing(10008);
		}),
	);
	expect(await deleted.threadStarter(THREAD)).toBeUndefined();
	const empty = surfaceWith(thread(ChannelType.GuildText, async () => null));
	expect(await empty.threadStarter(THREAD)).toBeUndefined();
	const plain = surfaceWith({ isThread: () => false });
	expect(await plain.threadStarter("5")).toBeUndefined();
	const gone = surfaceWith(null);
	expect(await gone.threadStarter("5")).toBeUndefined();
});

test("REAL ADAPTER: another Discord failure rejects, and the reader still goes without the starter", async () => {
	const surface = surfaceWith(
		thread(ChannelType.GuildText, async () => {
			throw missing(50013);
		}),
	);
	await expect(surface.threadStarter(THREAD)).rejects.toThrow();
	const r = new ChannelContextReader({
		read: async () => [source("20", "reply")],
		owners: async () => [OWNER],
		starter: (id) => surface.threadStarter(id),
		settings: {},
		logger: recordingLogger().logger,
	});
	expect(
		(await r.of(inbound(), { starter: true }))?.messages.map((m) => m.id),
	).toEqual(["20"]);
});

test("REAL ADAPTER + READER: a post whose first message lies outside the fetched window is included, oldest first", async () => {
	const surface = surfaceWith(
		thread(ChannelType.GuildForum, async () =>
			discordMessage(STARTER, "forum post body"),
		),
	);
	const r = new ChannelContextReader({
		read: async () => [source("20", "reply one"), source("21", "reply two")],
		owners: async () => [OWNER],
		starter: (id) => surface.threadStarter(id),
		settings: {},
		logger: recordingLogger().logger,
	});
	const got = await r.of(inbound(), { starter: true });
	expect(got?.messages.map((m) => m.id)).toEqual([STARTER, "20", "21"]);
});
