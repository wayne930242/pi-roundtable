import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
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

test("a context.turns turn names its channel, so a thread's answering turn does not report the parent channel", () => {
	const open = new TurnRecord(message);
	// A queue task in the thread, a turn through it, the settled turn inside, then the admission ends.
	open.begin("discord:thread");
	open.begin("discord:thread");
	open.begin("discord:thread");
	open.end();
	expect(open.channels()).toEqual(["discord:thread"]);
});
