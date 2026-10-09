import { describe, expect, test } from "bun:test";
import type {
	Admission,
	BackgroundTarget,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import { PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
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
		/** What `stop` answers; absent gives the claim no `stop`. */
		stops?: boolean;
	} = {},
): ChannelClaim {
	const { channels = [], guild } = options;
	return {
		name,
		priority,
		owns: (channel, space) =>
			channels.length === 0 ||
			channels.includes(channel) ||
			(guild !== undefined && space === guild),
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
		...(options.stops === undefined
			? {}
			: {
					stop: (channel: ChannelKey) => {
						log.push(`${name} stop ${channel}`);
						return options.stops === true;
					},
				}),
		...(options.deletes
			? {
					deleteConversation: async (channel: ChannelKey) =>
						void log.push(`${name} delete ${channel}`),
				}
			: {}),
	};
}

/** Two sample targets, so routing tests need no host's own. */
const TARGETS: readonly BackgroundTarget[] = [
	{ name: "main", label: () => "Main" },
	{ name: "open", label: () => "Open" },
];

/** Background turns run as the principals of this map: "owner", the owner, and "ci", a member. */
const PRINCIPALS = mapIdentity({
	owners: ["owner"],
	members: { users: ["ci"] },
});

function router(claims: ChannelClaim[], queue = new ChannelQueue()) {
	return new ChannelRouter({
		claims,
		targets: (name) => TARGETS.find((target) => target.name === name),
		queue,
		logger: silentLogger(),
		principals: PRINCIPALS,
		forwardJoinMs: 10,
	});
}

describe("orderClaims", () => {
	test("orders by descending priority, keeping registration order among equals", () => {
		const log: string[] = [];
		const ordered = orderClaims([
			claim("owner", 0, log),
			claim("open", 20, log),
			claim("first", 30, log),
			claim("second", 30, log),
			claim("agents", 100, log),
		]);
		expect(ordered.map((c) => c.name)).toEqual([
			"agents",
			"first",
			"second",
			"open",
			"owner",
		]);
	});

	test("refuses a claim name used twice", () => {
		const log: string[] = [];
		expect(() =>
			orderClaims([claim("open", 20, log), claim("open", 0, log)]),
		).toThrow(PluginError);
	});
});

describe("ChannelRouter", () => {
	test("the highest claim owning a channel answers there; the owner takes the rest", async () => {
		const log: string[] = [];
		const routing = router([
			claim("owner", 0, log),
			claim("open", 20, log, { channels: ["discord:open"] }),
			claim("agents", 100, log, { channels: ["discord:agent"] }),
		]);
		await routing.handle(message({ channel: "discord:open", text: "a" }));
		await routing.handle(message({ channel: "discord:agent", text: "b" }));
		await routing.handle(message({ channel: "discord:dm", text: "c" }));
		expect(log).toEqual(["open a", "agents b", "owner c"]);
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
		await routing.handle(message({ space: "agent-guild", text: "notes" }));
		await routing.handle(message({ space: "other", text: "hello" }));
		expect(log).toEqual(["owner hello"]);
	});

	test("a stop goes to the claim that owns the channel and to no other", async () => {
		const log: string[] = [];
		const routing = router([
			claim("owner", 0, log, { stops: true }),
			claim("open", 20, log, { channels: ["discord:open"] }),
			claim("agents", 100, log, { channels: ["discord:agent"], stops: true }),
			claim("quiet", 50, log, { channels: ["quiet:1"], stops: false }),
		]);
		expect(routing.stop("discord:agent")).toBe(true);
		expect(routing.stop("discord:dm")).toBe(true);
		// The claim's own answer, false, stands.
		expect(routing.stop("quiet:1")).toBe(false);
		expect(log).toEqual([
			"agents stop discord:agent",
			"owner stop discord:dm",
			"quiet stop quiet:1",
		]);
	});

	test("a claim without stop stops nothing, and the claims below it are not asked", () => {
		const log: string[] = [];
		const routing = router([
			claim("owner", 0, log, { stops: true }),
			claim("open", 20, log, { channels: ["discord:open"] }),
		]);
		expect(routing.stop("discord:open")).toBe(false);
		expect(log).toEqual([]);
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
		const routing = router([claim("open", 0, log)], queue);
		const first = routing.handle(message({ text: "one" }));
		await routing.handle(message({ text: "two" }));
		await first;
		expect(log).toEqual(["open one", "open two"]);
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
						target: "main",
						author: { principalId: "ci", id: "ci", name: "CI" },
						tier: "member",
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

	test("a turn for a target nobody contributes is skipped and reaches no claim", async () => {
		const log: string[] = [];
		const routing = router([claim("main", 0, log), claim("open", 20, log)]);
		expect(
			await routing.background({
				channel: "discord:1",
				target: "gone",
				author: { principalId: "owner", id: "owner", name: "Riley" },
				tier: "owner",
				turnId: "schedule-2",
				text: "reminder",
			}),
		).toEqual({
			status: "skipped",
			reason: 'no plugin contributes the background target "gone"',
		});
		expect(log).toEqual([]);
	});

	test("target reads a contributed target by name, and is undefined for another", () => {
		const routing = router([]);
		expect(routing.target("open")?.label("en")).toBe("Open");
		expect(routing.target("gone")).toBeUndefined();
	});

	test("background turns and starting over go to the channel's owner when their queued turn starts", async () => {
		const log: string[] = [];
		const queue = new ChannelQueue();
		const open = new Set<string>();
		const routing = router(
			[
				claim("owner", 0, log),
				{
					...claim("open", 20, log),
					owns: (channel) => open.has(channel),
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
			target: "open",
			author: { principalId: "owner", id: "owner", name: "Riley" },
			tier: "owner",
			turnId: "schedule-1",
			text: "reminder",
		});
		const fresh = routing.startFresh("discord:1");
		// Open mode turns on while the turn waits in the queue.
		open.add("discord:1");
		release();
		await blocker;
		expect(await turn).toEqual({ status: "ran" });
		expect(await fresh).toBe("open");
		expect(log).toEqual(["open background reminder", "open fresh discord:1"]);
	});

	test("marks a restart on the channel's surface once the claim started over, and logs a surface that cannot", async () => {
		const marked: string[] = [];
		let fail = false;
		const surfaces = {
			of: (channel: ChannelKey) =>
				channel.startsWith("discord:")
					? {
							surface: "discord",
							start: async () => undefined,
							sendReply: async () => undefined,
							markFresh: async (key: ChannelKey) => {
								if (fail) throw new Error("Missing Permissions");
								marked.push(key);
							},
						}
					: undefined,
		};
		const recorded = recordingLogger();
		const routing = new ChannelRouter({
			claims: [claim("desk", 0, [])],
			targets: () => undefined,
			queue: new ChannelQueue(),
			logger: recorded.logger,
			surfaces,
		});
		expect(await routing.startFresh("discord:1")).toBe("desk");
		expect(marked).toEqual(["discord:1"]);
		expect(await routing.startFresh("web:1")).toBe("desk");
		expect(marked).toEqual(["discord:1"]);
		fail = true;
		expect(await routing.startFresh("discord:2")).toBe("desk");
		expect(
			recorded.lines.some(
				(line) =>
					line.level === "warn" && line.message.includes("Missing Permissions"),
			),
		).toBe(true);
	});

	test("deletes only through a claim that deletes, and never while the channel is busy", async () => {
		const log: string[] = [];
		const queue = new ChannelQueue();
		const routing = router(
			[
				claim("owner", 0, log, { deletes: true }),
				claim("open", 20, log, { channels: ["discord:open"] }),
			],
			queue,
		);
		await expect(routing.deleteConversation("discord:open")).rejects.toThrow(
			"discord:open is not an owner conversation",
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
				...claim("open", 20, log, { channels: ["discord:open"] }),
				postsInPlace: true,
			},
		]);
		expect(routing.postsInPlace("discord:open")).toBe(true);
		expect(routing.postsInPlace("discord:dm")).toBe(false);
	});

	test("a claim takes the host's own reports unless it says it does not", () => {
		const routing = router([
			claim("owner", 0, [], { channels: ["discord:dm"] }),
			{
				...claim("web", 20, [], { channels: ["web:ops"] }),
				takesSystemReports: false,
			},
		]);
		expect(routing.takesSystemReports("discord:dm")).toBe(true);
		expect(routing.takesSystemReports("web:ops")).toBe(false);
		expect(routing.takesSystemReports("test:hall")).toBe(false);
	});

	test("says whether a claim owns a channel", () => {
		const routing = router([claim("room", 0, [], { channels: ["test:room"] })]);
		expect(routing.owns("test:room")).toBe(true);
		expect(routing.owns("test:hall")).toBe(false);
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
