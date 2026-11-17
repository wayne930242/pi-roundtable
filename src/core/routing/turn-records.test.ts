import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import { settleTurn, settleTurnIn } from "./settle-turn.ts";
import {
	currentHop,
	currentRecord,
	TurnRecord,
	underHop,
	underRecord,
} from "./turn-records.ts";

const message: InboundMessage = {
	channel: "discord:1",
	messageId: "m1",
	authorId: "riley",
	authorName: "Riley",
	authorIsBot: false,
	isDirect: true,
	mentionsBot: false,
	repliesToBot: false,
	text: "m1",
	attachments: [],
};
const record = new TurnRecord(message);

test("leaving a record's work leaves an exchange's origin too, as a background turn or an opening task does", () => {
	const hop = { record, since: 0 };
	expect(underHop(hop, () => currentHop())).toBe(hop);
	expect(underHop(hop, () => currentRecord())).toBeUndefined();
	expect(underHop(hop, () => underRecord(undefined, () => currentHop()))).toBe(
		undefined,
	);
	expect(underRecord(record, () => currentHop())).toBeUndefined();
});

test("a record counts the channels its turns run in until each ends", () => {
	const open = new TurnRecord(message);
	open.begin("discord:2");
	open.begin("discord:2");
	open.begin("discord:3");
	open.end("discord:2");
	// The admission itself still runs, naming no channel: its message's counts.
	expect(open.channels()).toEqual(["discord:2", "discord:3", "discord:1"]);
	open.end("discord:2");
	open.end("discord:3");
	expect(open.channels()).toEqual(["discord:1"]);
	// A bare turn keeps it open after the admission ended, in its message's channel.
	open.begin();
	open.end();
	expect(open.channels()).toEqual(["discord:1"]);
	open.end();
	expect(open.channels()).toEqual([]);
});

test("a turn settled in a channel, as context.turns and the agent team settle theirs, names it, so a thread's turn does not report the first message's channel", async () => {
	const open = new TurnRecord(message);
	const turn = Promise.withResolvers<{ ok: true; text: string }>();
	const named = underRecord(open, () =>
		settleTurnIn("discord:thread", () => turn.promise, "turn"),
	);
	const bare = Promise.withResolvers<{ ok: true; text: string }>();
	// The admission ends; the turn still runs.
	open.end();
	expect(open.channels()).toEqual(["discord:thread"]);
	// A bare one, outside any queue task, is waited for in the first message's channel.
	const unnamed = underRecord(open, () =>
		settleTurn(() => bare.promise, "turn"),
	);
	expect(open.channels()).toEqual(["discord:thread", "discord:1"]);
	turn.resolve({ ok: true, text: "a" });
	bare.resolve({ ok: true, text: "b" });
	await Promise.all([named, unnamed]);
	expect(open.channels()).toEqual([]);
});
