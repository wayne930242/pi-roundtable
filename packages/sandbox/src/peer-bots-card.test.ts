import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChannelKey,
	definePlugin,
	IDENTITY,
	type InboundMessage,
	type OutboundReply,
	type Speaker,
} from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { SandboxChannelStore } from "./channel-store.ts";
import { type SandboxReplyCard, sandboxClaim } from "./claim.ts";

const GUILD = "900000000000000001";
const PEER = "800000000000000001";
const OTHER_BOT = "800000000000000002";
const CARD = new Uint8Array([137, 80, 78, 71]);

const served = servicePair(IDENTITY, {
	resolve: async (facts) =>
		["alice", PEER, OTHER_BOT].includes(facts.subject)
			? ({
					id: facts.subject,
					name: facts.name,
					tier: "member",
					principalId: `p_${facts.subject}`,
				} as Speaker)
			: undefined,
});

const message: InboundMessage = {
	channel: "discord:900",
	messageId: "one",
	authorId: "alice",
	authorName: "Alice",
	authorIsBot: false,
	isDirect: false,
	mentionsBot: true,
	repliesToBot: false,
	text: "Hello",
	attachments: [],
	space: GUILD,
};

const fromBot = (id: string, extra: Partial<InboundMessage> = {}) => ({
	...message,
	authorId: id,
	authorName: `bot ${id}`,
	authorIsBot: true,
	...extra,
});

async function harness(options: {
	reply?: { ok: boolean; text: string };
	replyCard?: SandboxReplyCard;
	peerBots?: boolean;
	allow?: string[];
}) {
	const root = mkdtempSync(join(tmpdir(), "sb-peer-card-"));
	const channels = new SandboxChannelStore(join(root, "c.json"), [], {
		guilds: [GUILD],
	});
	const sent: OutboundReply[] = [];
	const turns: string[] = [];
	const cardFailures: ChannelKey[] = [];
	const host = await testPlugin(
		definePlugin({
			name: "peer-card-claim",
			setup: (context) => ({
				channels: [
					sandboxClaim({
						channels,
						runtime: {
							runTurn: async (_channel, _speaker, text) => {
								turns.push(text);
								return options.reply ?? { ok: true, text: "answer" };
							},
							stop: () => true,
							startFresh: () => {},
						},
						surfaces: context.surfaces,
						...(options.replyCard
							? {
									replyCard: options.replyCard,
									reportCardFailure: (channel: ChannelKey) =>
										cardFailures.push(channel),
								}
							: {}),
						...(options.peerBots ? { peerBots: true } : {}),
					}),
				],
			}),
		}),
		{
			services: [served],
			...(options.allow
				? { peerBots: { allow: options.allow, maxRounds: 3 } }
				: {}),
			surfaces: [
				{
					surface: "discord",
					start: async () => {},
					sendReply: async (_channel, reply) => {
						sent.push(reply);
					},
				},
			],
		},
	);
	return {
		host,
		sent,
		turns,
		cardFailures,
		done: async () => {
			await host.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("a listed peer bot's mention gets a turn when the sandbox opts in; others do not", async () => {
	const run = await harness({ peerBots: true, allow: [PEER] });
	try {
		await run.host.conversations.handle(fromBot(PEER));
		await run.host.conversations.handle(fromBot(OTHER_BOT));
		await run.host.conversations.handle(
			fromBot(PEER, { mentionsBot: false, repliesToBot: false }),
		);
		expect(run.turns).toHaveLength(1);
	} finally {
		await run.done();
	}
});

test("without the sandbox's opt-in a listed peer bot is ignored", async () => {
	const run = await harness({ allow: [PEER] });
	try {
		await run.host.conversations.handle(fromBot(PEER));
		expect(run.turns).toEqual([]);
	} finally {
		await run.done();
	}
});

test("the opt-in without a host allowlist answers no bot", async () => {
	const run = await harness({ peerBots: true });
	try {
		await run.host.conversations.handle(fromBot(PEER));
		expect(run.turns).toEqual([]);
	} finally {
		await run.done();
	}
});

test("bot-to-bot turns stop at the host's cap until a person posts", async () => {
	const run = await harness({ peerBots: true, allow: [PEER] });
	try {
		for (let n = 0; n < 5; n++)
			await run.host.conversations.handle(
				fromBot(PEER, { messageId: `b${n}` }),
			);
		expect(run.turns).toHaveLength(3);
		await run.host.conversations.handle(message);
		await run.host.conversations.handle(fromBot(PEER, { messageId: "again" }));
		expect(run.turns).toHaveLength(5);
	} finally {
		await run.done();
	}
});

test("replyCard sets the card of the reply, from the posted text, with the channel and guild", async () => {
	const seen: unknown[] = [];
	const run = await harness({
		reply: { ok: true, text: "abc" },
		replyCard: async (text, context) => {
			seen.push({ text, context });
			return CARD;
		},
	});
	try {
		await run.host.conversations.handle(message);
		expect(run.sent).toEqual([{ chunks: ["abc"], card: CARD }]);
		expect(seen).toEqual([
			{ text: "abc", context: { channel: "discord:900", space: GUILD } },
		]);
	} finally {
		await run.done();
	}
});

test("a replyCard that returns nothing posts the reply without a card", async () => {
	const run = await harness({ replyCard: () => undefined });
	try {
		await run.host.conversations.handle(message);
		expect(run.sent).toEqual([{ chunks: ["answer"] }]);
	} finally {
		await run.done();
	}
});

test("a replyCard that throws or rejects posts the reply without a card and reports it", async () => {
	for (const replyCard of [
		() => {
			throw new Error("boom");
		},
		() => Promise.reject(new Error("later")),
	]) {
		const run = await harness({ replyCard });
		try {
			await run.host.conversations.handle(message);
			expect(run.sent).toEqual([{ chunks: ["answer"] }]);
			expect(run.cardFailures).toEqual(["discord:900"]);
		} finally {
			await run.done();
		}
	}
});

test("a failed turn's text gets no card", async () => {
	const calls: string[] = [];
	const run = await harness({
		reply: { ok: false, text: "ignored" },
		replyCard: (text) => {
			calls.push(text);
			return CARD;
		},
	});
	try {
		await run.host.conversations.handle(message);
		expect(calls).toEqual([]);
		expect(run.sent).toEqual([{ chunks: ["The sandbox turn failed."] }]);
	} finally {
		await run.done();
	}
});
