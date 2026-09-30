import { describe, expect, test } from "bun:test";
import type {
	Admission,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import { PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter, orderClaims } from "./channel-router.ts";

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

/** A claim over `channels` (every channel when empty) that records what it does in `log`. */
function claim(
	name: string,
	priority: number,
	log: string[],
	options: {
		channels?: string[];
		guild?: string;
		admit?: (message: InboundMessage) => Admission | undefined;
		deletes?: boolean;
	} = {},
): ChannelClaim {
	const { channels = [], guild } = options;
	return {
		name,
		priority,
		owns: (channel, guildId) =>
			channels.length === 0 ||
			channels.includes(channel) ||
			(guild !== undefined && guildId === guild),
		admit:
			options.admit ??
			((m) => ({
				kind: "turn",
				run: async () => void log.push(`${name} ${m.text}`),
				failure: `${name} failed`,
			})),
		background: async (turn) => {
			log.push(`${name} background ${turn.text}`);
			return { status: "ran" };
		},
		startFresh: async (channel) => {
			log.push(`${name} fresh ${channel}`);
			return name;
		},
		...(options.deletes
			? {
					deleteConversation: async (channel: ChannelKey) =>
						void log.push(`${name} delete ${channel}`),
				}
			: {}),
	};
}

function router(claims: ChannelClaim[], queue = new ChannelQueue()) {
	return new ChannelRouter({
		claims,
		queue,
		stop: () => false,
		logger: silentLogger(),
		forwardJoinMs: 10,
	});
}

describe("orderClaims", () => {
	test("orders by descending priority, keeping registration order among equals", () => {
		const log: string[] = [];
		const ordered = orderClaims([
			claim("owner", 0, log),
			claim("party", 20, log),
			claim("first", 30, log),
			claim("second", 30, log),
			claim("agents", 100, log),
		]);
		expect(ordered.map((c) => c.name)).toEqual([
			"agents",
			"first",
			"second",
			"party",
			"owner",
		]);
	});

	test("refuses a claim name used twice", () => {
		const log: string[] = [];
		expect(() =>
			orderClaims([claim("party", 20, log), claim("party", 0, log)]),
		).toThrow(PluginError);
	});
});

describe("ChannelRouter", () => {
	test("the highest claim owning a channel answers there; the owner takes the rest", async () => {
		const log: string[] = [];
		const routing = router([
			claim("owner", 0, log),
			claim("party", 20, log, { channels: ["discord:party"] }),
			claim("agents", 100, log, { channels: ["discord:agent"] }),
		]);
		await routing.handle(message({ channel: "discord:party", text: "a" }));
		await routing.handle(message({ channel: "discord:agent", text: "b" }));
		await routing.handle(message({ channel: "discord:dm", text: "c" }));
		expect(log).toEqual(["party a", "agents b", "owner c"]);
	});

	test("a message the owning claim refuses is dropped, never passed to a lower claim", async () => {
		const log: string[] = [];
		const routing = router([
			claim("owner", 0, log),
			claim("agents", 100, log, {
				channels: ["discord:agent"],
				guild: "agent-guild",
				admit: () => undefined,
			}),
		]);
		await routing.handle(message({ guildId: "agent-guild", text: "notes" }));
		await routing.handle(message({ guildId: "other", text: "hello" }));
		expect(log).toEqual(["owner hello"]);
	});

	test("an empty message reaches no claim", async () => {
		const log: string[] = [];
		await router([claim("owner", 0, log)]).handle(message({ text: " " }));
		expect(log).toEqual([]);
	});

	test("a message during a turn is offered to it, else marked until its own turn starts", async () => {
		const log: string[] = [];
		const queue = new ChannelQueue();
		let takes = true;
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			release = resolve;
		});
		const routing = router(
			[
				claim("owner", 0, log, {
					admit: (m) => ({
						kind: "turn",
						busy: {
							steer: async () => takes,
							react: async (emoji) => void log.push(`+${emoji} ${m.text}`),
							unreact: async (emoji) => void log.push(`-${emoji} ${m.text}`),
						},
						run: async () => {
							log.push(`run ${m.text}`);
							if (m.text === "first") await running;
						},
						failure: "failed",
					}),
				}),
			],
			queue,
		);
		const first = routing.handle(message({ text: "first" }));
		await Bun.sleep(1);
		await routing.handle(message({ text: "steered" }));
		takes = false;
		const waiting = routing.handle(message({ text: "waiting" }));
		await Bun.sleep(1);
		release();
		await Promise.all([first, waiting]);
		expect(log).toEqual([
			"run first",
			"+↪️ steered",
			"+⏳ waiting",
			"-⏳ waiting",
			"run waiting",
		]);
	});

	test("a claim without busy handling is never marked", async () => {
		const log: string[] = [];
		const queue = new ChannelQueue();
		const routing = router([claim("party", 0, log)], queue);
		const first = routing.handle(message({ text: "one" }));
		await routing.handle(message({ text: "two" }));
		await first;
		expect(log).toEqual(["party one", "party two"]);
	});

	test("a background admission runs as a background turn and reports when it did not run", async () => {
		const log: string[] = [];
		const routing = router([
			{
				...claim("agents", 0, log),
				admit: (m) => ({
					kind: "background",
					turn: {
						channel: m.channel,
						mode: "owner",
						author: { id: "ci", name: "CI" },
						turnId: "webhook-1",
						text: m.text,
						report: true,
					},
					unanswered: (outcome) => log.push(`unanswered ${outcome.status}`),
				}),
				background: async () => ({ status: "skipped", reason: "busy" }),
			},
		]);
		await routing.handle(message({ text: "build failed" }));
		expect(log).toEqual(["unanswered skipped"]);
	});

	test("background turns and starting over go to the channel's owner when their queued turn starts", async () => {
		const log: string[] = [];
		const queue = new ChannelQueue();
		const party = new Set<string>();
		const routing = router(
			[
				claim("owner", 0, log),
				{
					...claim("party", 20, log),
					owns: (channel) => party.has(channel),
				},
			],
			queue,
		);
		let release = () => {};
		const blocker = queue.run(
			"discord:1",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await Bun.sleep(1);
		const turn = routing.background({
			channel: "discord:1",
			mode: "party",
			author: { id: "owner", name: "Riley" },
			turnId: "schedule-1",
			text: "reminder",
		});
		const fresh = routing.startFresh("discord:1");
		// Party mode turns on while the turn waits in the queue.
		party.add("discord:1");
		release();
		await blocker;
		expect(await turn).toEqual({ status: "ran" });
		expect(await fresh).toBe("party");
		expect(log).toEqual(["party background reminder", "party fresh discord:1"]);
	});

	test("deletes only through a claim that deletes, and never while the channel is busy", async () => {
		const log: string[] = [];
		const queue = new ChannelQueue();
		const routing = router(
			[
				claim("owner", 0, log, { deletes: true }),
				claim("party", 20, log, { channels: ["discord:party"] }),
			],
			queue,
		);
		await expect(routing.deleteConversation("discord:party")).rejects.toThrow(
			"discord:party is not an owner conversation",
		);
		let release = () => {};
		const blocker = queue.run(
			"discord:1",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await Bun.sleep(1);
		expect(await routing.deleteConversation("discord:1")).toBe("busy");
		release();
		await blocker;
		// The queue counts the finished task out once its tail settles.
		await Bun.sleep(1);
		expect(await routing.deleteConversation("discord:1")).toBe("deleted");
		expect(log).toEqual(["owner delete discord:1"]);
	});

	test("reports stay in place only where the channel's owner says so", () => {
		const log: string[] = [];
		const routing = router([
			claim("owner", 0, log),
			{
				...claim("party", 20, log, { channels: ["discord:party"] }),
				postsInPlace: true,
			},
		]);
		expect(routing.postsInPlace("discord:party")).toBe(true);
		expect(routing.postsInPlace("discord:dm")).toBe(false);
	});

	test("a turn that throws is logged and the next still runs", async () => {
		const log: string[] = [];
		const routing = router([
			claim("owner", 0, log, {
				admit: (m) => ({
					kind: "turn",
					run: async () => {
						if (m.text === "boom") throw new Error("boom");
						log.push(`run ${m.text}`);
					},
					failure: "failed",
				}),
			}),
		]);
		await routing.handle(message({ text: "boom" }));
		await routing.handle(message({ text: "next" }));
		expect(log).toEqual(["run next"]);
	});
});
