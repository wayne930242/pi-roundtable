import { expect, test } from "bun:test";
import { createCanvas } from "canvas";
import {
	type ChannelContext,
	withChannelContext,
	withChannelContextImages,
} from "../contract/channel-context.ts";
import type { InboundMessage } from "../contract/channels.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import {
	CHANNEL_CONTEXT_DEFAULTS,
	ChannelContextReader,
	type ContextSourceMessage,
	contextSourceOf,
	selectChannelContext,
} from "./channel-context.ts";
import { contextImages } from "./context-images.ts";

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
	foreignWebhook?: (webhookId: string) => boolean | "skip",
) {
	return selectChannelContext(fetched, {
		seen: new Set(),
		owners: [],
		settings: { ...SETTINGS, ...(foreignWebhook ? { foreignWebhook } : {}) },
	}).messages;
}

const NOTICES = "w-notices";
const isMirrorOrNotices = (webhookId: string) =>
	webhookId === BRIDGE ? true : webhookId === NOTICES ? "skip" : false;

/** A status notice the plugin posts through its own webhook. */
const notice = (id: string) =>
	source(id, "the bridge is back online", {
		authorId: NOTICES,
		authorName: "Status",
		bot: true,
		own: true,
		webhookId: NOTICES,
	});

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

test('a webhook the host answers "skip" for is dropped between the mirror\'s posts and does not end the window', () => {
	const fetched = [
		mirrored("1", "Ana", "before the notice"),
		notice("2"),
		mirrored("3", "Ben", "after the notice"),
		notice("4"),
	];
	expect(select(fetched, isMirrorOrNotices).map((m) => m.id)).toEqual([
		"1",
		"3",
	]);
	// Answered false instead, the same notice is the assistant's and ends the window.
	expect(select(fetched, (id) => id === BRIDGE).map((m) => m.id)).toEqual([]);
});

test('an answer other than true and "skip" reads as false: the post is the assistant\'s', () => {
	const fetched = [
		mirrored("1", "Ana", "before"),
		mirrored("2", "Ben", "after"),
	];
	for (const answer of [undefined, "other", 1, null]) {
		expect(select(fetched, (() => answer) as never).map((m) => m.id)).toEqual(
			[],
		);
	}
});

test("a skipped post is not in the window the reader marks as delivered, and a reply still ends the window", () => {
	const chosen = selectChannelContext(
		[
			mirrored("1", "Ana", "old"),
			reply("2"),
			mirrored("3", "Ben", "new"),
			notice("4"),
		],
		{
			seen: new Set(),
			owners: [],
			settings: { ...SETTINGS, foreignWebhook: isMirrorOrNotices },
		},
	);
	expect(chosen.messages.map((m) => m.id)).toEqual(["3"]);
	expect(chosen.window).toEqual(["3"]);
});

test('"skip" is not near-repeat merged into its neighbours', () => {
	const fetched = [
		mirrored("1", "Ana", "the bridge is back online"),
		notice("2"),
		mirrored("3", "Ana", "the bridge is back online!"),
	];
	expect(select(fetched, isMirrorOrNotices).map((m) => m.id)).toEqual(["3"]);
});

test("the reader drops a skipped webhook, keeps the window open across it, and hands each kept post over once", async () => {
	const fetched = [
		mirrored("10", "Ana", "first"),
		notice("11"),
		mirrored("12", "Ben", "second"),
	];
	const { reader: r } = reader(async () => fetched, {
		foreignWebhook: isMirrorOrNotices,
	});
	const first = await r.of(inbound());
	expect(first?.messages.map((m) => m.id)).toEqual(["10", "12"]);
	expect(first?.text).not.toContain("back online");
	fetched.push(notice("13"));
	expect(await r.of(inbound({ messageId: "60" }))).toBeUndefined();
	fetched.push(mirrored("14", "Cy", "third"));
	const third = await r.of(inbound({ messageId: "70" }));
	expect(third?.messages.map((m) => m.id)).toEqual(["14"]);
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
	// The block itself says nothing of images: only the turn that carries them does.
	expect(got?.text).not.toContain("Pictures posted");
	// The images are the turn's: they join its own after the turn's, within the limit of four.
	const own = {
		...NO_ATTACHMENTS,
		images: Array.from({ length: 3 }, () => ({
			data: "x",
			mimeType: "image/png",
		})),
	};
	const { attachments: merged, kept } = withChannelContextImages(own, got);
	expect(merged.images).toHaveLength(4);
	expect(merged.images.slice(0, 3)).toEqual(own.images);
	expect(merged.images[3]).toEqual(got?.images?.[0]);
	// Only one of the two fitted, and the text says pictures are there because one is.
	expect(kept).toBe(1);
	expect(withChannelContext("hi", got, kept)).toContain(
		"Pictures posted in the channel messages above are shown to you",
	);
	expect(withChannelContextImages(own, undefined)).toEqual({
		attachments: own,
		kept: 0,
	});
});

test("a turn that already carries four images keeps none of the context's, and its text does not claim any", async () => {
	const messages = [source("10", "a", { attachments: [file("a.png")] })];
	const net = bodies({ "a.png": png() });
	const { reader: r } = reader(async () => messages, {}, net.fetchImpl);
	const got = await r.of(inbound(), { attachments: { images: 1 } });
	expect(got?.images).toHaveLength(1);
	const full = {
		...NO_ATTACHMENTS,
		images: Array.from({ length: 4 }, () => ({
			data: "x",
			mimeType: "image/png",
		})),
	};
	const { attachments, kept } = withChannelContextImages(full, got);
	expect(attachments.images).toEqual(full.images);
	expect(kept).toBe(0);
	expect(withChannelContext("hi", got, kept)).not.toContain("Pictures posted");
	// A claim that never calls it tells nothing of pictures either.
	expect(withChannelContext("hi", got)).not.toContain("Pictures posted");
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
				file("fake.png"),
				file("plain.png", { url: "http://cdn.example/plain.png" }),
			],
		}),
	];
	const net = bodies({
		"gone.png": 404,
		// A PNG signature and nothing else: it says what it is and cannot be read.
		"broken.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
		"fake.png": new Uint8Array([1, 2, 3]),
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
	// What the bytes are decides, not the name Discord went by.
	expect(text).toContain("[image not attached: fake.png: unsupported type]");
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
	const { attachments, kept } = withChannelContextImages(
		NO_ATTACHMENTS,
		context,
	);
	expect(attachments).toBe(NO_ATTACHMENTS);
	expect(kept).toBe(0);
});

test("without a foreign webhook, an outside webhook's two names are merged as one author's near repeats, as before", () => {
	const post = (id: string, name: string, text: string) =>
		source(id, text, {
			authorId: "w-outside",
			authorName: name,
			bot: true,
			own: false,
		});
	const fetched = [
		post("1", "Ana", "meet at the north gate at dusk"),
		post("2", "Ben", "meet at the north gate at dusk!"),
	];
	expect(select(fetched).map((m) => m.id)).toEqual(["2"]);
	expect(select(fetched, isBridge).map((m) => m.id)).toEqual(["2"]);
});

test("the defaults cannot be changed from outside, the attachments' included", () => {
	expect(Object.isFrozen(CHANNEL_CONTEXT_DEFAULTS)).toBe(true);
	expect(Object.isFrozen(CHANNEL_CONTEXT_DEFAULTS.attachments)).toBe(true);
	expect(() => {
		(CHANNEL_CONTEXT_DEFAULTS.attachments as { images: number }).images = 4;
	}).toThrow();
	expect(CHANNEL_CONTEXT_DEFAULTS.attachments.images).toBe(0);
});

/** JPEG bytes of a few pixels. */
function jpeg(): Uint8Array {
	const canvas = createCanvas(4, 4);
	canvas.getContext("2d").fillRect(0, 0, 4, 4);
	return new Uint8Array(canvas.toBuffer("image/jpeg"));
}

test("an image is sent as the type its bytes show, whatever Discord guessed from the name", async () => {
	const messages = [
		source("10", "a", {
			attachments: [file("really-a-jpeg.png"), file("no-type.png")],
		}),
	];
	const net = bodies({ "really-a-jpeg.png": jpeg(), "no-type.png": png() });
	const { reader: r } = reader(async () => messages, {}, net.fetchImpl);
	const got = await r.of(inbound(), { attachments: { images: 2 } });
	expect(got?.images?.map((image) => image.mimeType).toSorted()).toEqual([
		"image/jpeg",
		"image/png",
	]);
});

/** A fetch that never answers until its signal fires, counting how many are in flight at most. */
function hanging() {
	const state = { inFlight: 0, peak: 0, asked: 0 };
	const fetchImpl = ((_url: string, init?: RequestInit) => {
		state.asked++;
		state.inFlight++;
		state.peak = Math.max(state.peak, state.inFlight);
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				state.inFlight--;
				reject(new Error("aborted"));
			});
		});
	}) as unknown as typeof fetch;
	return { state, fetchImpl };
}

test("the images of one call share a deadline: what is still to be fetched when it passes is skipped, and no more than two are fetched at once", async () => {
	const candidates = Array.from({ length: 8 }, (_, index) => ({
		...file(`p${index}.png`),
		messageId: "10",
	}));
	const net = hanging();
	const started = Date.now();
	const { images, skipped } = await contextImages(candidates, {
		count: 4,
		maxBytes: 1_000_000,
		fetchImpl: net.fetchImpl,
		logger: recordingLogger().logger,
		deadlineMs: 100,
	});
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(images).toEqual([]);
	expect(net.state.peak).toBeLessThanOrEqual(2);
	// Every one it was to try, up to twice the count, is named with the one reason.
	expect(skipped).toHaveLength(8);
	expect(skipped.every((image) => image.reason === "download failed")).toBe(
		true,
	);
	expect(net.state.asked).toBeLessThan(8);
});

test("fetching two at a time keeps the newest-first order and stops at the asked number", async () => {
	const candidates = ["a", "b", "c", "d", "e"].map((name) => ({
		...file(`${name}.png`),
		messageId: "10",
	}));
	const net = bodies({
		"a.png": png(2),
		"b.png": png(3),
		"c.png": png(4),
		"d.png": png(5),
		"e.png": png(6),
	});
	const { images } = await contextImages(candidates, {
		count: 3,
		maxBytes: 1_000_000,
		fetchImpl: net.fetchImpl,
		logger: recordingLogger().logger,
	});
	expect(images.map((image) => image.data)).toEqual(
		[2, 3, 4].map((side) => Buffer.from(png(side)).toString("base64")),
	);
	expect(net.asked).toEqual(
		["a", "b", "c"].map((name) => `https://cdn.example/${name}.png`),
	);
});
