import { describe, expect, test } from "bun:test";
import type {
	Admission,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import type { ActorFacts } from "../identity/actor-facts.ts";
import type { ContactAssessor } from "../identity/contact.ts";
import { silentLogger } from "../log.ts";
import type { Speaker, Tier } from "../speakers.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: "discord:1",
		messageId: "m1",
		authorId: "owner",
		authorName: "Riley",
		authorIsBot: false,
		isDirect: true,
		mentionsBot: false,
		repliesToBot: false,
		text: "hi",
		attachments: [],
		...overrides,
	};
}

/** A claim over `channels` (every channel when empty) that admits as `admit` says. */
function claim(
	name: string,
	priority: number,
	log: string[],
	options: {
		channels?: string[];
		admit?: (message: InboundMessage) => Admission | undefined;
	} = {},
): ChannelClaim {
	const { channels = [] } = options;
	return {
		name,
		priority,
		owns: (channel) => channels.length === 0 || channels.includes(channel),
		admit:
			options.admit ??
			((m) => ({
				kind: "turn",
				run: async () => void log.push(`${name} ${m.text}`),
				failure: `${name} failed`,
			})),
		startFresh: async () => name,
	};
}

/** An assessor that serves the ids in `tiers`, recording what it assessed and took in `log`. */
function contacts(
	tiers: Record<string, Tier>,
	log: string[],
	options: { takeAs?: string; delayMs?: (facts: ActorFacts) => number } = {},
): ContactAssessor {
	return {
		assess: async (facts) => {
			const ms = options.delayMs?.(facts) ?? 0;
			if (ms) await new Promise((done) => setTimeout(done, ms));
			log.push(`assess ${facts.provider}:${facts.subject}`);
			const tier = tiers[facts.subject];
			if (!tier) return undefined;
			const speaker: Speaker = {
				id: facts.legacyId ?? facts.subject,
				name: facts.name,
				tier,
				principalId: `p-${facts.subject}`,
			};
			return {
				speaker,
				take: async () => {
					log.push(`take ${facts.subject}`);
					return options.takeAs
						? { ...speaker, principalId: options.takeAs }
						: speaker;
				},
			};
		},
	};
}

/** A claim that admits a message only when it carries a speaker, and records whom. */
function speakerClaim(log: string[]): ChannelClaim {
	return claim("people", 0, log, {
		admit: (m) =>
			m.speaker
				? {
						kind: "turn",
						run: async () =>
							void log.push(
								`run ${m.text} by ${m.speaker?.principalId} at ${m.speaker?.tier}`,
							),
						failure: "failed",
					}
				: undefined,
	});
}

describe("ChannelRouter resolving who wrote a message", () => {
	const routerWith = (
		claims: ChannelClaim[],
		assessor: ContactAssessor | undefined,
		logger = silentLogger(),
	) =>
		new ChannelRouter({
			claims,
			targets: () => undefined,
			queue: new ChannelQueue(),
			logger,
			...(assessor ? { contacts: assessor } : {}),
		});
	const actor = (subject: string, roles?: string[]): ActorFacts => ({
		provider: "discord",
		subject,
		name: subject,
		surface: "discord",
		...(roles ? { roles } : {}),
		legacyId: subject,
	});

	test("the speaker a surface sets is dropped: the claim sees only the router's", async () => {
		const log: string[] = [];
		const seen: (Speaker | undefined)[] = [];
		const forged: Speaker = {
			id: "eve",
			name: "Eve",
			tier: "owner",
			principalId: "owner",
		};
		const routing = routerWith(
			[
				claim("people", 0, log, {
					admit: (m) => {
						seen.push(m.speaker);
						return undefined;
					},
				}),
			],
			contacts({ ada: "member" }, log),
		);
		await routing.handle(
			message({ authorId: "eve", actor: actor("eve"), speaker: forged }),
		);
		await routing.handle(
			message({ authorId: "ada", actor: actor("ada"), speaker: forged }),
		);
		expect(seen).toEqual([
			undefined,
			{ id: "ada", name: "ada", tier: "member", principalId: "p-ada" },
		]);
		// Without an identity service nobody is anyone, whatever the surface says.
		const bare: (Speaker | undefined)[] = [];
		await routerWith(
			[
				claim("people", 0, log, {
					admit: (m) => {
						bare.push(m.speaker);
						return undefined;
					},
				}),
			],
			undefined,
		).handle(message({ speaker: forged }));
		expect(bare).toEqual([undefined]);
	});

	test("a contact is recorded only once a claim takes the message", async () => {
		const log: string[] = [];
		const routing = routerWith(
			[
				claim("picky", 0, log, {
					channels: ["discord:1"],
					admit: (m) =>
						m.speaker && m.text === "take"
							? {
									kind: "turn",
									run: async () =>
										void log.push(`run by ${m.speaker?.principalId}`),
									failure: "failed",
								}
							: undefined,
				}),
			],
			contacts({ ada: "member" }, log),
		);
		// No claim owns discord:2, so its author is not even assessed.
		await routing.handle(
			message({ channel: "discord:2", authorId: "ada", actor: actor("ada") }),
		);
		await routing.handle(
			message({ text: "skip", authorId: "ada", actor: actor("ada") }),
		);
		await routing.handle(
			message({ text: "take", authorId: "ada", actor: actor("ada") }),
		);
		expect(log).toEqual([
			"assess discord:ada",
			"assess discord:ada",
			"take ada",
			"run by p-ada",
		]);
	});

	test("an author who cannot be assessed reaches the claim as no one, and a contact that cannot be recorded leaves the admission standing", async () => {
		const log: string[] = [];
		const recorded = recordingLogger();
		// The claim decided on the speaker it saw; a claim may hold state for what it admitted, so it runs.
		await routerWith(
			[speakerClaim(log)],
			contacts({ ada: "member" }, log, { takeAs: "p-other" }),
			recorded.logger,
		).handle(message({ authorId: "ada", actor: actor("ada") }));
		await routerWith(
			[
				speakerClaim(log),
				claim("anyone", 1, log, {
					channels: ["discord:2"],
					admit: (m) => ({
						kind: "turn",
						run: async () => void log.push(`anyone ran, speaker ${m.speaker}`),
						failure: "failed",
					}),
				}),
			],
			{
				assess: async () => {
					throw new Error("database down");
				},
			},
			recorded.logger,
		).handle(message({ authorId: "ada", actor: actor("ada") }));
		await routerWith(
			[
				claim("anyone", 1, log, {
					admit: (m) => ({
						kind: "turn",
						run: async () => void log.push(`anyone ran, speaker ${m.speaker}`),
						failure: "failed",
					}),
				}),
			],
			{
				assess: async () => {
					throw new Error("database down");
				},
			},
			recorded.logger,
		).handle(message({ authorId: "ada", actor: actor("ada") }));
		expect(log).toEqual([
			"assess discord:ada",
			"take ada",
			"run hi by p-ada at member",
			"anyone ran, speaker undefined",
		]);
		expect(recorded.lines.map((line) => line.level)).toEqual([
			"warn",
			"error",
			"error",
		]);
	});

	test("bots and integrations are not assessed", async () => {
		const log: string[] = [];
		const seen: (Speaker | undefined)[] = [];
		const routing = routerWith(
			[
				claim("people", 0, log, {
					admit: (m) => {
						seen.push(m.speaker);
						return undefined;
					},
				}),
			],
			contacts({ ada: "owner" }, log),
		);
		await routing.handle(
			message({ authorId: "ada", authorIsBot: true, actor: actor("ada") }),
		);
		await routing.handle(
			message({
				authorId: "ada",
				actor: actor("ada"),
				integration: { id: "w1", own: false },
			}),
		);
		expect(log).toEqual([]);
		expect(seen).toEqual([undefined, undefined]);
	});

	test("a surface that reports no actor has its author read from the author fields, warned once", async () => {
		const log: string[] = [];
		const recorded = recordingLogger();
		const routing = routerWith(
			[speakerClaim(log)],
			{
				assess: async (facts) => {
					log.push(JSON.stringify(facts));
					return undefined;
				},
			},
			recorded.logger,
		);
		await routing.handle(
			message({
				channel: "chat:1",
				authorId: "u1",
				authorName: "Uma",
				authorRoleIds: ["r1"],
				space: "g1",
			}),
		);
		await routing.handle(message({ channel: "chat:1", authorId: "u2" }));
		expect(log.map((line) => JSON.parse(line))).toEqual([
			{
				provider: "chat",
				subject: "u1",
				name: "Uma",
				surface: "chat",
				roles: ["chat:role:r1"],
				space: "g1",
				legacyId: "u1",
			},
			{
				provider: "chat",
				subject: "u2",
				name: "Riley",
				surface: "chat",
				legacyId: "u2",
			},
		]);
		const warnings = recorded.lines.filter((line) => line.level === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("deprecated");
	});

	test("a channel's messages reach their claim in the order they came, however long each takes to assess", async () => {
		const log: string[] = [];
		const routing = routerWith(
			[speakerClaim(log)],
			contacts({ slow: "member", fast: "member" }, log, {
				delayMs: (facts) => (facts.subject === "slow" ? 30 : 0),
			}),
		);
		await Promise.all([
			routing.handle(
				message({ text: "first", authorId: "slow", actor: actor("slow") }),
			),
			routing.handle(
				message({ text: "second", authorId: "fast", actor: actor("fast") }),
			),
		]);
		expect(log.filter((line) => line.startsWith("run"))).toEqual([
			"run first by p-slow at member",
			"run second by p-fast at member",
		]);
	});
});
