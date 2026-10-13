import { expect, test } from "bun:test";
import { createCanvas } from "canvas";
import {
	type ChannelContext,
	withChannelContextImages,
} from "../contract/channel-context.ts";
import type { InboundMessage } from "../contract/channels.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import {
	ChannelContextReader,
	type ContextSourceMessage,
	contextSourceOf,
	selectChannelContext,
} from "./channel-context.ts";

const BOT = "900";
const BRIDGE = "w-bridge";
const VOICE = "w-voice";

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
function mirrored(id: string, name: string, text: string, extra = {}) {
	return source(id, text, {
		authorId: BRIDGE,
		authorName: name,
		bot: true,
		own: true,
		webhookId: BRIDGE,
		...extra,
	});
}

/** A reply of the assistant: its bot user. */
const reply = (id: string) =>
	source(id, "an answer", {
		authorId: BOT,
		authorName: "Bot",
		bot: true,
		own: true,
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

const SETTINGS = {
	fetch: 50,
	keep: 15,
	similarity: 0.8,
	messageChars: 500,
	botMessageChars: 80,
};
const isBridge = (webhookId: string) => webhookId === BRIDGE;

function select(
	fetched: ContextSourceMessage[],
	foreignWebhook?: (webhookId: string) => boolean,
) {
	return selectChannelContext(fetched, {
		seen: new Set(),
		owners: [],
		settings: { ...SETTINGS, ...(foreignWebhook ? { foreignWebhook } : {}) },
	}).messages;
}

test("by default a post of the application's webhook is the assistant's: it ends the window and is left out", () => {
	const fetched = [
		source("1", "before"),
		mirrored("2", "Ana", "from the mirror"),
		source("3", "after"),
	];
	expect(select(fetched).map((m) => m.id)).toEqual(["3"]);
});

test("a webhook the host calls foreign speaks for other people: kept as a bot by the post's name, and the window stays open", () => {
	const fetched = [
		mirrored("1", "Ana", "hello from outside"),
		mirrored("2", "Ben", "me too"),
		source("3", "a local message"),
	];
	expect(select(fetched, isBridge)).toEqual([
		expect.objectContaining({
			id: "1",
			authorName: "Ana",
			bot: true,
			owner: false,
			text: "hello from outside",
		}),
		expect.objectContaining({ id: "2", authorName: "Ben", bot: true }),
		expect.objectContaining({ id: "3", bot: false }),
	]);
});

test("the window still ends at the assistant's own reply, its bot user's or another webhook's, never the mirror's", () => {
	const afterReply = [
		mirrored("1", "Ana", "before the reply"),
		reply("2"),
		mirrored("3", "Ben", "after the reply"),
	];
	expect(select(afterReply, isBridge).map((m) => m.id)).toEqual(["3"]);
	const afterVoice = [
		mirrored("1", "Ana", "before the voice"),
		voice("2"),
		mirrored("3", "Ben", "after the voice"),
		voice("4"),
		mirrored("5", "Cy", "last"),
	];
	expect(select(afterVoice, isBridge).map((m) => m.id)).toEqual(["5"]);
});

test("the assistant's own posts are left out even when the mirror's are kept", () => {
	const fetched = [mirrored("1", "Ana", "hi"), voice("2")];
	expect(select(fetched, isBridge).map((m) => m.id)).toEqual([]);
});

test("two people mirrored through one webhook are not merged as a near repeat, one person's repost is", () => {
	const fetched = [
		mirrored("1", "Ana", "meet at the north gate at dusk"),
		mirrored("2", "Ben", "meet at the north gate at dusk!"),
		mirrored("3", "Ben", "meet at the north gate at dusk!!"),
	];
	expect(select(fetched, isBridge).map((m) => m.id)).toEqual(["1", "3"]);
});

test("a Discord message through the application's webhook carries the webhook's id; another webhook's and a person's do not", () => {
	const self = { botId: BOT, applicationId: "app" };
	const message = (extra: Record<string, unknown>) =>
		({
			id: "m",
			content: "x",
			createdTimestamp: 5,
			author: { id: "w", bot: true, username: "Ana" },
			member: null,
			webhookId: null,
			applicationId: null,
			mentions: { users: new Map(), members: new Map() },
			stickers: new Map(),
			attachments: new Map(),
			...extra,
		}) as never;
	expect(
		contextSourceOf(message({ webhookId: "w", applicationId: "app" }), self),
	).toEqual(expect.objectContaining({ own: true, webhookId: "w" }));
	expect(
		contextSourceOf(message({ webhookId: "w2", applicationId: null }), self)
			.webhookId,
	).toBeUndefined();
	expect(contextSourceOf(message({}), self).webhookId).toBeUndefined();
});

function inbound(extra: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: "discord:77",
		messageId: "50",
		authorId: "100",
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

function reader(
	read: () => Promise<ContextSourceMessage[]>,
	settings: ConstructorParameters<typeof ChannelContextReader>[0]["settings"],
	fetchImpl?: typeof fetch,
) {
	const recorded = recordingLogger();
	return {
		lines: recorded.lines,
		reader: new ChannelContextReader({
			read,
			owners: async () => [],
			settings,
			logger: recorded.logger,
			...(fetchImpl ? { fetchImpl } : {}),
		}),
	};
}

test("the reader keeps the mirror's posts under the host's predicate, a call's overrides it, and none is handed over twice", async () => {
	const fetched = [
		mirrored("10", "Ana", "first"),
		mirrored("11", "Ben", "second"),
	];
	const { reader: r } = reader(async () => fetched, {
		foreignWebhook: isBridge,
	});
	const first = await r.of(inbound());
	expect(first?.messages.map((m) => m.authorName)).toEqual(["Ana", "Ben"]);
	expect(first?.text).toContain(
		'<message from="Ana" id="w-bridge" role="bot">first</message>',
	);
	fetched.push(mirrored("12", "Cy", "third"));
	const second = await r.of(inbound({ messageId: "60" }));
	expect(second?.messages.map((m) => m.id)).toEqual(["12"]);
	// A call that says no webhook is foreign reads the same channel as the assistant's own posts.
	const { reader: other } = reader(async () => fetched, {
		foreignWebhook: isBridge,
	});
	expect(
		await other.of(inbound(), { foreignWebhook: () => false }),
	).toBeUndefined();
});

test("without a predicate the reader behaves as before", async () => {
	const { reader: r } = reader(
		async () => [mirrored("10", "Ana", "first"), source("11", "second")],
		{},
	);
	expect((await r.of(inbound()))?.messages.map((m) => m.id)).toEqual(["11"]);
});

/** A PNG of a few pixels, as a response body. */
function png(side = 4): Uint8Array {
	const canvas = createCanvas(side, side);
	const context = canvas.getContext("2d");
	context.fillStyle = "#336699";
	context.fillRect(0, 0, side, side);
	return new Uint8Array(canvas.toBuffer("image/png"));
}

const file = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	url: `https://cdn.example/${name}`,
	contentType: "image/png",
	size: 100,
	...extra,
});

/** A fetch that answers from a table of bodies by URL and counts what it was asked. */
function bodies(table: Record<string, Uint8Array | number>) {
	const asked: string[] = [];
	const fetchImpl = (async (url: string) => {
		asked.push(url);
		const body = table[url.replace("https://cdn.example/", "")];
		if (body === undefined) throw new Error("connection refused");
		if (typeof body === "number") return new Response("no", { status: body });
		return new Response(body);
	}) as unknown as typeof fetch;
	return { asked, fetchImpl };
}

test("metadata of the attachments is always there; images are fetched only when asked for", async () => {
	const messages = [
		source("10", "a picture", { attachments: [file("a.png")] }),
	];
	const none = bodies({ "a.png": png() });
	const { reader: r } = reader(async () => messages, {}, none.fetchImpl);
	const got = await r.of(inbound());
	expect(got?.messages[0]?.attachments).toEqual([
		{ ...file("a.png"), messageId: "10" },
	]);
	expect(got?.images).toBeUndefined();
	expect(none.asked).toEqual([]);
});

test("up to the asked number of images come back, newest first, as the turn's model images", async () => {
	const messages = [
		source("10", "old", { attachments: [file("old.png")] }),
		source("11", "middle", { attachments: [file("m1.png"), file("m2.png")] }),
		source("12", "new", { attachments: [file("new.png")] }),
	];
	const net = bodies({
		"old.png": png(),
		"m1.png": png(),
		"m2.png": png(),
		"new.png": png(),
	});
	const { reader: r } = reader(async () => messages, {}, net.fetchImpl);
	const got = await r.of(inbound(), { attachments: { images: 2 } });
	expect(net.asked).toEqual([
		"https://cdn.example/new.png",
		"https://cdn.example/m1.png",
	]);
	expect(got?.images).toHaveLength(2);
	expect(got?.images?.[0]).toEqual({
		data: Buffer.from(png()).toString("base64"),
		mimeType: "image/png",
	});
	expect(got?.text).toContain("Pictures posted in them are shown to you");
	// The images are the turn's: they join its own after the turn's, within the limit of four.
	const own = {
		...NO_ATTACHMENTS,
		images: Array.from({ length: 3 }, () => ({
			data: "x",
			mimeType: "image/png",
		})),
	};
	const merged = withChannelContextImages(own, got);
	expect(merged.images).toHaveLength(4);
	expect(merged.images.slice(0, 3)).toEqual(own.images);
	expect(merged.images[3]).toEqual(got?.images?.[0]);
	expect(withChannelContextImages(own, undefined)).toBe(own);
});

test("an image that is too large, of a type the model does not take, not fetchable or not decodable is skipped and named in its message", async () => {
	const messages = [
		source("10", "pictures", {
			attachments: [
				file("huge.png", { size: 50_000_000 }),
				file("vector.svg", { contentType: "image/svg+xml" }),
				file("gone.png"),
				file("down.png"),
				file("broken.png"),
				file("plain.png", { url: "http://cdn.example/plain.png" }),
			],
		}),
	];
	const net = bodies({
		"gone.png": 404,
		"broken.png": new Uint8Array([1, 2, 3]),
	});
	const { reader: r } = reader(async () => messages, {}, net.fetchImpl);
	const got = await r.of(inbound(), { attachments: { images: 4 } });
	expect(got?.images).toBeUndefined();
	const text = got?.messages[0]?.text ?? "";
	expect(text).toContain("[image not attached: huge.png: too large]");
	expect(text).toContain("[image not attached: vector.svg: unsupported type]");
	expect(text).toContain("[image not attached: gone.png: download failed]");
	expect(text).toContain("[image not attached: down.png: download failed]");
	expect(text).toContain(
		"[image not attached: broken.png: could not be decoded]",
	);
	expect(text).toContain("[image not attached: plain.png: unsupported type]");
	expect(got?.text).not.toContain("Pictures posted in them");
	// Nothing over the declared size was ever requested.
	expect(net.asked).not.toContain("https://cdn.example/huge.png");
});

test("a body that outgrows maxBytes while it arrives is skipped, and the next image is tried", async () => {
	const messages = [
		source("10", "pictures", {
			attachments: [file("liar.png", { size: 10 }), file("fine.png")],
		}),
	];
	const net = bodies({ "liar.png": new Uint8Array(5_000), "fine.png": png() });
	const { reader: r } = reader(async () => messages, {}, net.fetchImpl);
	const got = await r.of(inbound(), {
		attachments: { images: 1, maxBytes: 2_000 },
	});
	expect(got?.images).toHaveLength(1);
	expect(got?.messages[0]?.text).toContain(
		"[image not attached: liar.png: too large]",
	);
});

test("the host's image settings and a call's merge member by member; an image that was handed over comes no more", async () => {
	const messages = [source("10", "a", { attachments: [file("a.png")] })];
	const net = bodies({ "a.png": png() });
	const { reader: r } = reader(
		async () => messages,
		{ attachments: { images: 1, maxBytes: 5_000_000 } },
		net.fetchImpl,
	);
	const first = await r.of(inbound(), { attachments: { maxBytes: 4_000_000 } });
	expect(first?.images).toHaveLength(1);
	// The message was handed over; so were its images.
	expect(await r.of(inbound({ messageId: "60" }))).toBeUndefined();
	expect(net.asked).toHaveLength(1);
});

test("image options are validated like the others", async () => {
	const { reader: r } = reader(async () => [source("1", "a")], {});
	const call = (options: Parameters<ChannelContextReader["of"]>[1]) =>
		r.of(inbound(), options);
	await expect(call({ attachments: { images: 5 } })).rejects.toThrow(
		"attachments.images",
	);
	await expect(call({ attachments: { images: 1.5 } })).rejects.toThrow(
		"attachments.images",
	);
	await expect(call({ attachments: { maxBytes: 0 } })).rejects.toThrow(
		"attachments.maxBytes",
	);
	await expect(
		call({ attachments: { maxBytes: 26 * 1024 * 1024 } }),
	).rejects.toThrow("attachments.maxBytes");
	await expect(call({ foreignWebhook: "w" as never })).rejects.toThrow(
		"foreignWebhook",
	);
});

test("withChannelContextImages leaves the turn's attachments alone for a context without images", () => {
	const context: ChannelContext = { messages: [], text: "BLOCK" };
	expect(withChannelContextImages(NO_ATTACHMENTS, context)).toBe(
		NO_ATTACHMENTS,
	);
});
