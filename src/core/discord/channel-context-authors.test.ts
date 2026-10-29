import { expect, test } from "bun:test";
import { formatChannelContext } from "../contract/channel-context.ts";
import {
	type ContextSourceMessage,
	selectChannelContext,
} from "./channel-context.ts";

const BOT = "900";
const BRIDGE = "w-bridge";
const VOICE = "w-voice";
const NOTICES = "w-notices";
const OWNER_ID = "100";

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

/** A post through the webhook that mirrors people into the channel. */
const mirrored = (id: string, name: string, text: string) =>
	source(id, text, {
		authorId: BRIDGE,
		authorName: name,
		bot: true,
		own: true,
		webhookId: BRIDGE,
	});

/** An agent's voice: another webhook of the application. */
const voice = (id: string) =>
	source(id, "an agent's reply", {
		authorId: VOICE,
		authorName: "Librarian",
		bot: true,
		own: true,
		webhookId: VOICE,
	});

/** A status notice the plugin posts through its own webhook. */
const notice = (id: string) =>
	source(id, "the bridge is back online", {
		authorId: NOTICES,
		authorName: "Bridge",
		bot: true,
		own: true,
		webhookId: NOTICES,
	});

const SETTINGS = {
	fetch: 50,
	keep: 15,
	similarity: 0.8,
	messageChars: 500,
	botMessageChars: 80,
};
const isMirrorOrNotices = (webhookId: string) =>
	webhookId === BRIDGE ? true : webhookId === NOTICES ? "skip" : false;

test('authors "skip" drops a post like foreignWebhook\'s "skip", and "end" ends the window like an own post', () => {
	const fetched = [
		mirrored("1", "Ana", "before the notice"),
		notice("2"),
		mirrored("3", "Ben", "after the notice"),
		voice("4"),
		mirrored("5", "Cy", "after the voice"),
	];
	const viaHook = selectChannelContext(fetched, {
		seen: new Set(),
		owners: [],
		settings: { ...SETTINGS, foreignWebhook: isMirrorOrNotices },
	}).messages;
	const viaAuthors = selectChannelContext(fetched, {
		seen: new Set(),
		owners: [],
		settings: {
			...SETTINGS,
			authors: (message) =>
				message.webhookId === BRIDGE
					? "keep"
					: message.webhookId === NOTICES
						? "skip"
						: "end",
		},
	}).messages;
	expect(viaAuthors).toEqual(viaHook);
	expect(viaAuthors.map((m) => m.id)).toEqual(["5"]);
});

test("authors decides for any message, and its silence leaves the default", () => {
	const fetched = [
		source("1", "from a customer", { authorId: "c1", authorName: "Cu" }),
		source("2", "from the staff", { authorId: "s1", authorName: "Staff" }),
		source("3", "the assistant answered", {
			authorId: BOT,
			authorName: "Bot",
			bot: true,
			own: true,
		}),
		source("4", "a customer again", { authorId: "c1", authorName: "Cu" }),
		source("5", "an internal note", { authorId: "s1", authorName: "Staff" }),
	];
	const run = (
		authors: (
			message: ContextSourceMessage,
		) => "keep" | "skip" | "end" | undefined,
	) =>
		selectChannelContext(fetched, {
			seen: new Set(),
			owners: [],
			settings: { ...SETTINGS, authors },
		});
	// Silence: the assistant's post ends the window, everything after it is kept.
	expect(run(() => undefined).messages.map((m) => m.id)).toEqual(["4", "5"]);
	// "skip" drops one message and the window is otherwise as it was.
	const skipped = run((m) => (m.id === "5" ? "skip" : undefined));
	expect(skipped.messages.map((m) => m.id)).toEqual(["4"]);
	expect(skipped.window).toEqual(["4"]);
	// "end" on a message that is not the assistant's ends the window at it.
	expect(
		run((m) => (m.id === "4" ? "end" : undefined)).messages.map((m) => m.id),
	).toEqual(["5"]);
	// "keep" on an own post keeps it as another author's, and the window does not end at it.
	expect(
		run((m) => (m.id === "3" ? "keep" : undefined)).messages.map((m) => m.id),
	).toEqual(["1", "2", "3", "4", "5"]);
});

test("an external author is marked, never an owner, and the block says role external", () => {
	const got = selectChannelContext(
		[
			source("1", "Where is my order?", {
				authorId: OWNER_ID,
				authorName: "Customer",
				external: true,
			}),
		],
		{ seen: new Set(), owners: [OWNER_ID], settings: SETTINGS },
	).messages;
	expect(got).toEqual([
		expect.objectContaining({ external: true, owner: false, bot: false }),
	]);
	expect(formatChannelContext(got)).toContain(
		'<message from="Customer" id="100" role="external">Where is my order?</message>',
	);
});
