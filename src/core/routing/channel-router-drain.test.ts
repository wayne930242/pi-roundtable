import { describe, expect, test } from "bun:test";
import type {
	Admission,
	BackgroundTarget,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import type { SurfacePort } from "../contract/surface.ts";
import { silentLogger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import { mapIdentity } from "../testing/map-identity.ts";
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

const TARGETS: readonly BackgroundTarget[] = [
	{ name: "main", label: () => "Main" },
];

function setup(admit?: (m: InboundMessage, log: string[]) => Admission) {
	const log: string[] = [];
	const notices: { channel: ChannelKey; text: string }[] = [];
	const queue = new ChannelQueue();
	const claim: ChannelClaim = {
		name: "owner",
		priority: 0,
		owns: () => true,
		admit: (m) =>
			admit?.(m, log) ?? {
				kind: "turn",
				run: async () => void log.push(`run ${m.text}`),
				dropped: () => void log.push(`dropped ${m.text}`),
				failure: "failed",
			},
		background: async (turn) => {
			log.push(`background ${turn.text}`);
			return { status: "ran" };
		},
		startFresh: async () => "owner",
	};
	const routing = new ChannelRouter({
		claims: [claim],
		targets: (name) => TARGETS.find((target) => target.name === name),
		queue,
		logger: silentLogger(),
		principals: mapIdentity({ owners: ["owner"] }),
		surfaces: {
			of: () => undefined,
			sendReply: async (
				channel: ChannelKey,
				reply: Parameters<SurfacePort["sendReply"]>[1],
			) => void notices.push({ channel, text: reply.chunks.join("") }),
		},
		forwardJoinMs: 5,
	});
	return { log, notices, queue, routing };
}

describe("ChannelRouter while the host drains", () => {
	test("a new message does not start a turn, and its channel is told once that the host restarts", async () => {
		const { log, notices, queue, routing } = setup();
		await routing.handle(message({ text: "before" }));
		queue.close();
		await routing.handle(message({ text: "after" }));
		await routing.handle(message({ text: "again" }));
		expect(log).toEqual(["run before", "dropped after", "dropped again"]);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.channel).toBe("discord:1");
		expect(notices[0]?.text.length).toBeGreaterThan(0);
	});

	test("a message from a bot or an integration is refused without a reply", async () => {
		const { log, notices, queue, routing } = setup();
		queue.close();
		await routing.handle(message({ text: "report", authorIsBot: true }));
		await routing.handle(
			message({
				text: "hook",
				messageId: "m2",
				integration: { id: "hook", own: false },
			}),
		);
		expect(log.filter((line) => line.startsWith("run"))).toEqual([]);
		expect(notices).toEqual([]);
	});

	test("a message offered to a running turn is not steered into it", async () => {
		let steers = 0;
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { log, notices, queue, routing } = setup((m, log) => ({
			kind: "turn",
			busy: {
				steer: async () => {
					steers++;
					return true;
				},
				react: async () => undefined,
				unreact: async () => undefined,
			},
			run: async () => {
				log.push(`run ${m.text}`);
				if (m.text === "first") await running;
			},
			dropped: () => void log.push(`dropped ${m.text}`),
			failure: "failed",
		}));
		const first = routing.handle(message({ text: "first" }));
		await Bun.sleep(1);
		queue.close();
		await routing.handle(message({ text: "second" }));
		release();
		await first;
		expect(steers).toBe(0);
		expect(log).toEqual(["run first", "dropped second"]);
		expect(notices).toHaveLength(1);
	});

	test("a message waiting behind a running turn when the drain starts never runs", async () => {
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			release = resolve;
		});
		const marks: string[] = [];
		const { log, notices, queue, routing } = setup((m, log) => ({
			kind: "turn",
			busy: {
				react: async (emoji) => void marks.push(`+${emoji}`),
				unreact: async (emoji) => void marks.push(`-${emoji}`),
			},
			run: async () => {
				log.push(`run ${m.text}`);
				if (m.text === "first") await running;
			},
			dropped: () => void log.push(`dropped ${m.text}`),
			failure: "failed",
		}));
		const first = routing.handle(message({ text: "first" }));
		await Bun.sleep(1);
		const waiting = routing.handle(message({ text: "waiting" }));
		await Bun.sleep(1);
		queue.close();
		release();
		await Promise.all([first, waiting]);
		expect(log).toEqual(["run first", "dropped waiting"]);
		expect(marks).toEqual(["+⏳", "-⏳"]);
		expect(notices).toHaveLength(1);
	});

	test("a background turn is skipped, and says why", async () => {
		const { log, queue, routing } = setup();
		queue.close();
		const outcome = await routing.background({
			channel: "discord:1",
			target: "main",
			author: { principalId: "owner", id: "owner", name: "Riley" },
			tier: "owner",
			turnId: "t1",
			text: "scheduled",
		});
		expect(outcome.status).toBe("skipped");
		expect(log).toEqual([]);
	});

	test("a background admission reports that it did not run", async () => {
		const outcomes: string[] = [];
		const { log, queue, routing } = setup((m) => ({
			kind: "background",
			turn: {
				channel: m.channel,
				target: "main",
				author: { principalId: "owner", id: "owner", name: "Riley" },
				tier: "owner",
				turnId: "t2",
				text: m.text,
			},
			unanswered: (outcome) => void outcomes.push(outcome.status),
		}));
		queue.close();
		await routing.handle(message({ text: "hook", authorIsBot: true }));
		expect(log).toEqual([]);
		expect(outcomes).toEqual(["skipped"]);
	});
});
