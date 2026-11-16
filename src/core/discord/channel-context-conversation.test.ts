import { expect, test } from "bun:test";
import type { ChannelContextOptions } from "../contract/channel-context.ts";
import type { InboundMessage } from "../contract/channels.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import {
	ChannelContextReader,
	type ContextSourceMessage,
} from "./channel-context.ts";

// A forum post where two people ask in turn: each asker's turn runs in a conversation of its own,
// which the runtime makes anew, without the other's history, when the asker changes.

const POST = "77";
const ALICE = "301";
const BOB = "302";

function source(
	id: string,
	text: string,
	extra: Partial<ContextSourceMessage> = {},
): ContextSourceMessage {
	return {
		id,
		authorId: "200",
		authorName: "Kai",
		bot: false,
		own: false,
		at: Number(id),
		text,
		...extra,
	};
}

/** The post as it stands once every message below is posted; the reader sees those before the addressed one. */
const POSTED = [
	source("10", "a comment on the card"),
	source("20", "earlier discussion"),
	source("50", "@bot what is the state?", {
		authorId: ALICE,
		authorName: "Alice",
	}),
	source("55", "the answer to Alice", { own: true, authorId: "900" }),
	source("56", "a remark after the answer"),
	source("57", "@bot and the date?", { authorId: ALICE, authorName: "Alice" }),
	source("58", "the second answer", { own: true, authorId: "900" }),
	source("70", "@bot who owns it?", { authorId: BOB, authorName: "Bob" }),
	source("71", "the answer to Bob", { own: true, authorId: "900" }),
];

function inbound(messageId: string, authorId: string): InboundMessage {
	return {
		channel: `discord:${POST}`,
		messageId,
		authorId,
		authorName: authorId === ALICE ? "Alice" : "Bob",
		authorIsBot: false,
		isDirect: false,
		space: "g1",
		mentionsBot: true,
		repliesToBot: false,
		text: "?",
		attachments: [],
	};
}

/** The forum's options: the starter, and the assistant's answers left out without ending the window. */
const FORUM: ChannelContextOptions = {
	keep: 50,
	starter: true,
	authors: (message) => (message.own ? "skip" : undefined),
};

function reader(settings: ChannelContextOptions = {}) {
	return new ChannelContextReader({
		read: async (_channel, before) =>
			POSTED.filter((message) => Number(message.id) < Number(before)),
		owners: async () => [],
		starter: async () => source(POST, "the project card", { at: 1 }),
		settings,
		logger: recordingLogger().logger,
	});
}

const ids = (context: { messages: readonly { id: string }[] } | undefined) =>
	context?.messages.map((message) => message.id);

test("CONTRACT: conversation: a second asker gets the earlier messages and the starter; an asker's next turn repeats nothing", async () => {
	const r = reader();
	const asker = { ...FORUM, conversation: (m: InboundMessage) => m.authorId };
	expect(ids(await r.of(inbound("50", ALICE), asker))).toEqual([
		POST,
		"10",
		"20",
	]);
	// Alice again: only what was said since her last turn.
	expect(ids(await r.of(inbound("57", ALICE), asker))).toEqual(["56"]);
	// Bob's conversation has none of Alice's: the card, the comments, her questions.
	const bob = await r.of(inbound("70", BOB), asker);
	expect(ids(bob)).toEqual([POST, "10", "20", "50", "56", "57"]);
	expect(bob?.text).toContain("the project card");
	// Alice after Bob: her conversation was made anew, so it reads the post whole again.
	const back = await r.of(inbound("80", ALICE), asker);
	expect(ids(back)).toEqual([POST, "10", "20", "50", "56", "57", "70"]);
});

test("without conversation one record per channel stands, as before: the second asker gets only what is newer", async () => {
	const r = reader();
	expect(ids(await r.of(inbound("50", ALICE), FORUM))).toEqual([
		POST,
		"10",
		"20",
	]);
	expect(await r.of(inbound("57", ALICE), FORUM)).toEqual(
		expect.objectContaining({
			messages: [expect.objectContaining({ id: "56" })],
		}),
	);
	expect(await r.of(inbound("70", BOB), FORUM)).toBeUndefined();
});

test("conversation on the host's settings applies to every call; undefined is the channel's own conversation", async () => {
	const r = reader({ ...FORUM, conversation: (m) => m.authorId });
	expect(ids(await r.of(inbound("50", ALICE)))).toEqual([POST, "10", "20"]);
	expect(ids(await r.of(inbound("70", BOB)))).toEqual([
		POST,
		"10",
		"20",
		"50",
		"56",
		"57",
	]);
	// A call that names no conversation reads the channel's record, which Bob's turn replaced.
	const shared = reader({ ...FORUM, conversation: () => undefined });
	expect(ids(await shared.of(inbound("50", ALICE)))).toEqual([
		POST,
		"10",
		"20",
	]);
	expect(await shared.of(inbound("70", BOB))).toEqual(
		expect.objectContaining({
			messages: [
				expect.objectContaining({ id: "56" }),
				expect.objectContaining({ id: "57" }),
			],
		}),
	);
});

test("conversation must be a function", async () => {
	await expect(
		reader().of(inbound("50", ALICE), { conversation: "alice" as never }),
	).rejects.toThrow("channel context option conversation must be a function");
});
