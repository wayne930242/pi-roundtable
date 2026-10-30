import { describe, expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import type { Logger } from "../log.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";
import { MessageObservers } from "./message-observers.ts";
import { PeerBots } from "./peer-bots.ts";

const PEER = "800000000000000001";
const STRANGER = "800000000000000002";
const CHANNEL = "discord:700000000000000001";
const OTHER = "discord:700000000000000002";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: CHANNEL,
		messageId: "m1",
		authorId: "human",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		space: "600000000000000001",
		mentionsBot: false,
		repliesToBot: false,
		text: "hi",
		attachments: [],
		...overrides,
	};
}

function setup(
	claimOverrides: Partial<ChannelClaim> = {},
	rooms: readonly string[] = [],
) {
	const warnings: unknown[] = [];
	const logger = {
		warn: (fields: unknown) => warnings.push(fields),
		info: () => undefined,
		error: () => undefined,
	} as unknown as Logger;
	const admitted: string[] = [];
	const claim: ChannelClaim = {
		name: "claim",
		priority: 0,
		owns: (channel) => channel === CHANNEL,
		admit: (m) => {
			admitted.push(m.messageId);
			return undefined;
		},
		startFresh: async () => "kind",
		...claimOverrides,
	};
	const observers = new MessageObservers(logger, () => rooms);
	const routing = new ChannelRouter({
		claims: [claim],
		targets: () => undefined,
		queue: new ChannelQueue(),
		logger,
		observers,
		peerBots: new PeerBots({ allow: [PEER], maxRounds: 1 }),
	});
	return { routing, observers, admitted, warnings };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("message observers", () => {
	test("hear a message no claim admits, and change nothing for the claim", async () => {
		const { routing, observers, admitted } = setup();
		const heard: string[] = [];
		observers.add({}, (m) => void heard.push(m.text));
		await routing.handle(message({ text: "not for the bot" }));
		await tick();
		expect(heard).toEqual(["not for the bot"]);
		expect(admitted).toEqual(["m1"]);
	});

	test("a throwing or rejecting observer is logged by name and isolated", async () => {
		const { routing, observers, admitted, warnings } = setup();
		const heard: string[] = [];
		observers.add({}, () => {
			throw new RangeError("secret words");
		});
		observers.add({}, async () => {
			throw new TypeError("more secret words");
		});
		observers.add({}, (m) => void heard.push(m.text));
		await routing.handle(message());
		await tick();
		expect(heard).toEqual(["hi"]);
		expect(admitted).toEqual(["m1"]);
		expect(warnings.filter((w) => !("surface" in (w as object)))).toEqual([
			{ error: "RangeError" },
			{ error: "TypeError" },
		]);
	});

	test("a slow observer does not hold routing", async () => {
		const { routing, observers, admitted } = setup();
		let release: () => void = () => undefined;
		observers.add(
			{},
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		await routing.handle(message());
		expect(admitted).toEqual(["m1"]);
		release();
	});

	test("an observer that edits its message changes nothing for the claim or the others", async () => {
		const { routing, observers } = setup();
		const seen: string[] = [];
		observers.add({}, (m) => {
			try {
				(m as InboundMessage).text = "changed";
			} catch {
				// A frozen copy refuses in strict mode.
			}
		});
		observers.add({}, (m) => void seen.push(m.text));
		await routing.handle(message());
		await tick();
		expect(seen).toEqual(["hi"]);
	});

	test("direct messages are not heard unless the filter asks", async () => {
		const { routing, observers } = setup();
		const guild: string[] = [];
		const direct: string[] = [];
		observers.add({}, (m) => void guild.push(m.messageId));
		observers.add(
			{ includeDirect: true },
			(m) => void direct.push(m.messageId),
		);
		await routing.handle(message({ messageId: "g" }));
		await routing.handle(
			message({ messageId: "d", isDirect: true, space: undefined }),
		);
		await tick();
		expect(guild).toEqual(["g"]);
		expect(direct).toEqual(["g", "d"]);
	});

	test("filters narrow by surface, space and channel; a channel nobody owns is not heard", async () => {
		const { routing, observers } = setup({ owns: () => true });
		const heard: Record<string, string[]> = { a: [], b: [], c: [], d: [] };
		observers.add({ surface: "line" }, (m) => void heard.a?.push(m.messageId));
		observers.add({ space: "other" }, (m) => void heard.b?.push(m.messageId));
		observers.add(
			{ channels: [OTHER] },
			(m) => void heard.c?.push(m.messageId),
		);
		observers.add(
			{ surface: "discord", space: "600000000000000001" },
			(m) => void heard.d?.push(m.messageId),
		);
		await routing.handle(message({ messageId: "one" }));
		await routing.handle(message({ messageId: "two", channel: OTHER }));
		await tick();
		expect(heard).toEqual({ a: [], b: [], c: ["two"], d: ["one", "two"] });
		const none = setup({ owns: () => false });
		const unowned: string[] = [];
		none.observers.add({}, (m) => void unowned.push(m.messageId));
		await none.routing.handle(message());
		await tick();
		expect(unowned).toEqual([]);
	});

	test("hear people, listed peers (rounds used or not) and webhooks, never an unlisted bot", async () => {
		const { routing, observers } = setup();
		const heard: string[] = [];
		observers.add({}, (m) => void heard.push(m.messageId));
		const bot = (id: string, messageId: string) =>
			message({ authorId: id, authorIsBot: true, messageId });
		await routing.handle(bot(PEER, "peer1"));
		await routing.handle(bot(PEER, "peer2"));
		await routing.handle(bot(STRANGER, "stranger"));
		await routing.handle({
			...bot(STRANGER, "hook"),
			integration: { id: "wh", own: false },
		});
		await tick();
		expect(heard).toEqual(["peer1", "peer2", "hook"]);
	});

	test("a surface that hosts rooms is heard only by a filter that names it", async () => {
		const room = "app:agent.aria";
		const { routing, observers } = setup({ owns: () => true }, ["app"]);
		const heard: Record<string, string[]> = { all: [], space: [], app: [] };
		observers.add({}, (m) => void heard.all?.push(m.messageId));
		observers.add({ space: "w" }, (m) => void heard.space?.push(m.messageId));
		observers.add({ surface: "app" }, (m) => void heard.app?.push(m.messageId));
		await routing.handle(message({ messageId: "guild" }));
		await routing.handle(
			message({ messageId: "room", channel: room, space: "w" }),
		);
		await tick();
		expect(heard).toEqual({
			all: ["guild"],
			space: [],
			app: ["room"],
		});
	});

	test("a surface that hosts no rooms is heard by a filter that does not name it", async () => {
		const { routing, observers } = setup({ owns: () => true }, ["app"]);
		const heard: string[] = [];
		observers.add({ space: "w" }, (m) => void heard.push(m.messageId));
		await routing.handle(
			message({ messageId: "x", channel: "line:abc", space: "w" }),
		);
		await tick();
		expect(heard).toEqual(["x"]);
	});

	test("a message that cannot be cloned is dropped for the observer, never thrown into routing", async () => {
		const { routing, observers, admitted, warnings } = setup();
		const heard: string[] = [];
		observers.add({}, (m) => void heard.push(m.messageId));
		await routing.handle(
			message({
				messageId: "odd",
				metadata: () => undefined,
			} as unknown as Partial<InboundMessage>),
		);
		await routing.handle(message({ messageId: "plain" }));
		await tick();
		expect(heard).toEqual(["plain"]);
		expect(admitted).toEqual(["odd", "plain"]);
		expect(warnings).toContainEqual({ error: "DataCloneError" });
	});

	test("a removed observer hears nothing more", async () => {
		const { routing, observers } = setup();
		const heard: string[] = [];
		const stop = observers.add({}, (m) => void heard.push(m.messageId));
		await routing.handle(message({ messageId: "a" }));
		await tick();
		stop();
		await routing.handle(message({ messageId: "b" }));
		await tick();
		expect(heard).toEqual(["a"]);
	});
});

describe("claim message events", () => {
	test("a delete reaches only the claim that owns the channel", async () => {
		const deleted: string[] = [];
		const { routing } = setup({
			onMessageDeleted: (channel, id) => void deleted.push(`${channel} ${id}`),
		});
		await routing.messageDeleted(CHANNEL, "m9", "600000000000000001");
		await routing.messageDeleted(OTHER, "m8");
		expect(deleted).toEqual([`${CHANNEL} m9`]);
	});

	test("a speaker a surface sets is not on the copy an observer hears", async () => {
		const { routing, observers, admitted } = setup();
		const heard: InboundMessage[] = [];
		observers.add({}, (m) => void heard.push(m as InboundMessage));
		await routing.handle({
			...message(),
			speaker: { id: "x", name: "x", tier: "owner", principalId: "p" },
		});
		await tick();
		expect(heard).toHaveLength(1);
		expect(heard[0]).not.toHaveProperty("speaker");
		expect(heard[0]).not.toHaveProperty("peerBot");
		expect(admitted).toEqual(["m1"]);
	});

	test("an edit reaches the owner without a speaker or a peer flag", async () => {
		const edited: InboundMessage[] = [];
		const { routing } = setup({
			onMessageEdited: (m) => void edited.push(m),
		});
		await routing.messageEdited({
			...message({ text: "new words" }),
			peerBot: true,
			speaker: { id: "x", name: "x", tier: "owner", principalId: "p" },
		});
		expect(edited).toHaveLength(1);
		expect(edited[0]?.text).toBe("new words");
		expect(edited[0]).not.toHaveProperty("speaker");
		expect(edited[0]).not.toHaveProperty("peerBot");
	});

	test("a claim without the hooks, or one that throws, never fails the router", async () => {
		const bare = setup();
		await bare.routing.messageDeleted(CHANNEL, "m1");
		await bare.routing.messageEdited(message());
		const failing = setup({
			onMessageDeleted: () => {
				throw new Error("boom");
			},
			onMessageEdited: async () => {
				throw new Error("boom");
			},
		});
		await failing.routing.messageDeleted(CHANNEL, "m1");
		await failing.routing.messageEdited(message());
		expect(
			failing.warnings.filter((w) => "claim" in (w as object)),
		).toHaveLength(2);
	});
});
