import { describe, expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import { ConfigError } from "../domain/errors.ts";
import { factsTier } from "../identity/access-policy.ts";
import type { ContactAssessor } from "../identity/contact.ts";
import { silentLogger } from "../log.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";
import { answersAuthor, PeerBots, type PeerBotsConfig } from "./peer-bots.ts";

const PEER = "800000000000000001";
const STRANGER = "800000000000000002";
const CHANNEL = "discord:700000000000000001";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: CHANNEL,
		messageId: "m1",
		authorId: "human",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		space: "600000000000000001",
		mentionsBot: true,
		repliesToBot: false,
		text: "hi",
		attachments: [],
		...overrides,
	};
}

const fromBot = (id: string, text = "ping"): InboundMessage =>
	message({ authorId: id, authorName: `bot ${id}`, authorIsBot: true, text });

/** Serves everyone whose id is in `served`, as members. */
function contacts(served: string[]): ContactAssessor {
	return {
		assess: async (facts) => {
			if (!served.includes(facts.subject)) return undefined;
			const speaker = {
				id: facts.subject,
				name: facts.name,
				tier: "member" as const,
				principalId: `p-${facts.subject}`,
			};
			return { speaker, take: async () => speaker };
		},
	};
}

/** A claim like the sandbox's: it answers a person, or a peer the router flagged, when mentioned. */
function claim(log: string[]): ChannelClaim {
	return {
		name: "people",
		priority: 0,
		owns: () => true,
		admit: (m) =>
			answersAuthor(m) && m.speaker && m.mentionsBot
				? {
						kind: "turn",
						run: async () =>
							void log.push(
								`${m.text} by ${m.speaker?.principalId}${m.peerBot ? " (peer)" : ""}`,
							),
						failure: "failed",
					}
				: undefined,
		startFresh: async () => "people",
	};
}

function setup(peerBots: PeerBotsConfig | undefined, logger = silentLogger()) {
	const log: string[] = [];
	const routing = new ChannelRouter({
		claims: [claim(log)],
		targets: () => undefined,
		queue: new ChannelQueue(),
		logger,
		contacts: contacts(["human", PEER]),
		...(peerBots ? { peerBots: new PeerBots(peerBots) } : {}),
	});
	return { log, routing };
}

describe("peer bots in the router", () => {
	test("a bot nobody lists is ignored, as is every bot without the allowlist", async () => {
		const listed = setup({ allow: [PEER] });
		await listed.routing.handle(fromBot(STRANGER));
		const bare = setup(undefined);
		await bare.routing.handle(fromBot(PEER));
		expect(listed.log).toEqual([]);
		expect(bare.log).toEqual([]);
	});

	test("a listed bot's message is answered like a guest's, flagged as a peer's", async () => {
		const { log, routing } = setup({ allow: [PEER] });
		await routing.handle(fromBot(PEER, "hello"));
		expect(log).toEqual([`hello by p-${PEER} (peer)`]);
	});

	test("a listed bot the access rules do not serve gets no turn", async () => {
		const { log, routing } = setup({ allow: [STRANGER] });
		await routing.handle(fromBot(STRANGER));
		expect(log).toEqual([]);
	});

	test("a webhook is never a peer, even under a listed id", async () => {
		const { log, routing } = setup({ allow: [PEER] });
		await routing.handle({
			...fromBot(PEER),
			integration: { id: "wh", own: false },
		});
		expect(log).toEqual([]);
	});

	test("the flag a surface sets is dropped", async () => {
		const { log, routing } = setup({ allow: [PEER] });
		await routing.handle({ ...fromBot(STRANGER), peerBot: true });
		await routing.handle({ ...message(), peerBot: true });
		expect(log).toEqual(["hi by p-human"]);
	});

	test("the cap stops the fourth peer message in a row, and a person's post starts the count over", async () => {
		const recorded = recordingLogger();
		const { log, routing } = setup({ allow: [PEER] }, recorded.logger);
		for (const n of [1, 2, 3, 4, 5])
			await routing.handle({ ...fromBot(PEER, `b${n}`), messageId: `b${n}` });
		expect(log.map((line) => line.split(" ")[0])).toEqual(["b1", "b2", "b3"]);
		expect(
			recorded.lines.filter((line) => line.message.includes("rounds")),
		).toHaveLength(2);
		await routing.handle(message({ text: "h", messageId: "h1" }));
		await routing.handle({ ...fromBot(PEER, "b6"), messageId: "b6" });
		expect(log.map((line) => line.split(" ")[0])).toEqual([
			"b1",
			"b2",
			"b3",
			"h",
			"b6",
		]);
	});

	test("maxRounds sets the cap, and rounds are counted per channel", async () => {
		const { log, routing } = setup({ allow: [PEER], maxRounds: 1 });
		await routing.handle(fromBot(PEER, "a"));
		await routing.handle(fromBot(PEER, "b"));
		await routing.handle({
			...fromBot(PEER, "c"),
			channel: "discord:700000000000000002",
		});
		expect(log.map((line) => line.split(" ")[0])).toEqual(["a", "c"]);
	});

	test("a message no claim answers does not use up a round", async () => {
		const { log, routing } = setup({ allow: [PEER], maxRounds: 1 });
		await routing.handle({ ...fromBot(PEER, "chatter"), mentionsBot: false });
		await routing.handle(fromBot(PEER, "real"));
		expect(log.map((line) => line.split(" ")[0])).toEqual(["real"]);
	});
});

describe("a peer bot's roles", () => {
	const ROLE = "discord:role:900000000000000001";

	/** Serves by the access rules alone: a role rule makes an admin, an identity rule a member. */
	function byRules(log: string[], peerBots: PeerBotsConfig) {
		const rules = {
			admins: { roles: [ROLE] },
			members: { identities: [`discord:${PEER}`] },
		};
		const assessor: ContactAssessor = {
			assess: async (facts) => {
				const tier = factsTier(rules, facts);
				if (!tier) return undefined;
				const speaker = {
					id: facts.subject,
					name: facts.name,
					tier,
					principalId: `p-${facts.subject}`,
				};
				return { speaker, take: async () => speaker };
			},
		};
		const answering: ChannelClaim = {
			name: "tiers",
			priority: 0,
			owns: () => true,
			admit: (m) =>
				m.speaker
					? {
							kind: "turn",
							run: async () =>
								void log.push(`${m.authorId} ${m.speaker?.tier}`),
							failure: "failed",
						}
					: undefined,
			startFresh: async () => "tiers",
		};
		return new ChannelRouter({
			claims: [answering],
			targets: () => undefined,
			queue: new ChannelQueue(),
			logger: silentLogger(),
			contacts: assessor,
			peerBots: new PeerBots(peerBots),
		});
	}

	test("a role rule does not lift a listed peer above its identity rule", async () => {
		const log: string[] = [];
		const routing = byRules(log, { allow: [PEER, STRANGER] });
		const actor = (subject: string) => ({
			provider: "discord",
			subject,
			name: subject,
			surface: "discord",
			roles: [ROLE],
		});
		const asBot = (id: string) => ({
			...fromBot(id),
			actor: actor(id),
			authorRoleIds: ["900000000000000001"],
		});
		await routing.handle(asBot(PEER));
		// Listed and holding the admin role, but no identity rule serves it: not served at all.
		await routing.handle(asBot(STRANGER));
		await routing.handle({
			...message({ authorId: "person", mentionsBot: true }),
			actor: actor("person"),
		});
		expect(log).toEqual([`${PEER} member`, "person admin"]);
	});

	test("the roles of a surface that reports no actor are dropped for a peer as well", async () => {
		const log: string[] = [];
		const routing = byRules(log, { allow: [PEER] });
		await routing.handle({
			...fromBot(PEER),
			authorRoleIds: ["900000000000000001"],
		});
		expect(log).toEqual([`${PEER} member`]);
	});
});

describe("PeerBots", () => {
	const lists = (config: PeerBotsConfig, overrides: Partial<InboundMessage>) =>
		new PeerBots(config).lists({ ...fromBot(PEER), ...overrides });

	test("limits an entry to its servers and channels", () => {
		const entry = {
			id: PEER,
			guilds: ["600000000000000001"],
			channels: ["700000000000000001"],
		};
		expect(lists({ allow: [entry] }, {})).toBe(true);
		expect(lists({ allow: [entry] }, { space: "600000000000000009" })).toBe(
			false,
		);
		expect(
			lists({ allow: [entry] }, { channel: "discord:700000000000000009" }),
		).toBe(false);
		expect(lists({ allow: [entry] }, { space: undefined })).toBe(false);
	});

	test("lists only bots, and only on its surface", () => {
		expect(lists({ allow: [PEER] }, { authorIsBot: false })).toBe(false);
		expect(lists({ allow: [PEER] }, { channel: "web:abc" })).toBe(false);
	});

	test("refuses an id that is not a snowflake, naming the key, and has no wildcard", () => {
		const bad = (allow: unknown[], at = "peerBots") => {
			try {
				new PeerBots({ allow } as PeerBotsConfig, "discord", at);
			} catch (error) {
				if (error instanceof ConfigError) return error.message;
				throw error;
			}
			return "";
		};
		expect(bad(["herald"])).toContain("config peerBots.allow[0]");
		expect(bad([PEER, "*"], "discord.peerBots")).toContain(
			"config discord.peerBots.allow[1]: expected a Discord id",
		);
		expect(bad([{ id: PEER, channels: ["general"] }])).toContain(
			"peerBots.allow[0].channels[0]",
		);
		expect(bad([{ id: PEER, guilds: [123] }])).toContain(
			"peerBots.allow[0].guilds[0]",
		);
		expect(() => new PeerBots({ allow: [PEER], maxRounds: 0 })).toThrow(
			ConfigError,
		);
		expect(() => new PeerBots({ allow: [PEER], all: true } as never)).toThrow(
			ConfigError,
		);
	});
});

describe("answersAuthor", () => {
	const base = { authorIsBot: false, mentionsBot: false, repliesToBot: false };
	test("answers a person, and a flagged peer only when it addresses the bot", () => {
		expect(answersAuthor(base)).toBe(true);
		expect(answersAuthor({ ...base, authorIsBot: true })).toBe(false);
		expect(answersAuthor({ ...base, authorIsBot: true, peerBot: true })).toBe(
			false,
		);
		expect(
			answersAuthor({
				...base,
				authorIsBot: true,
				peerBot: true,
				repliesToBot: true,
			}),
		).toBe(true);
	});
});
