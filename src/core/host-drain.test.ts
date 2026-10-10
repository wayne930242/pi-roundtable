import { afterEach, describe, expect, test } from "bun:test";
import type {
	ChannelClaim,
	ConversationPort,
	InboundMessage,
} from "./contract/channels.ts";
import type { AgentRuntime } from "./contract/runtime.ts";
import type { ChatSurface } from "./contract/surface.ts";
import { HostStoppingError } from "./errors.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import type { ConversationTurns } from "./routing/conversation-turns.ts";
import { RUNTIME } from "./services.ts";
import type { ChannelKey } from "./sessions.ts";
import { OWNER_SPEAKER } from "./testing/owner.ts";

const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
});

function message(
	text: string,
	channel: ChannelKey = "fake:room",
): InboundMessage {
	return {
		channel,
		messageId: `m-${text}`,
		authorId: "owner",
		authorName: "Riley",
		authorIsBot: false,
		isDirect: true,
		mentionsBot: false,
		repliesToBot: false,
		text,
		attachments: [],
	};
}

/** A host whose one claim runs a turn per message; a message named `hold` waits until `release`. */
function setup(options: Partial<RoundtableOptions> = {}) {
	const log: string[] = [];
	const replies: string[] = [];
	const hold = Promise.withResolvers<void>();
	const taken: {
		conversations?: ConversationPort;
		turns?: ConversationTurns;
	} = {};
	const claim: ChannelClaim = {
		name: "fake",
		priority: 0,
		owns: (channel) => channel.startsWith("fake:"),
		admit: (m) => ({
			kind: "turn",
			run: async () => {
				log.push(`start ${m.text}`);
				if (m.text === "hold") await hold.promise;
				log.push(`end ${m.text}`);
			},
			failure: "failed",
		}),
		background: async (turn) => {
			log.push(`background ${turn.text}`);
			return { status: "ran" };
		},
		startFresh: async () => "fake",
		stop: (channel) => {
			log.push(`stop ${channel}`);
			return true;
		},
	};
	const surface: ChatSurface = {
		surface: "fake",
		start: async () => undefined,
		sendReply: async (_channel, reply) =>
			void replies.push(reply.chunks.join()),
	};
	const runtime = {
		runTurn: async () => ({ ok: true, text: "answer" }),
	} as unknown as AgentRuntime;
	const plugins: RoundtablePlugin[] = [
		{
			name: "runtime",
			provides: [RUNTIME],
			setup: (context) => {
				context.services.provide(RUNTIME, runtime);
				return { services: [{ name: "runtime" }] };
			},
		},
		{
			name: "fake",
			setup: (context) => {
				taken.conversations = context.conversations;
				taken.turns = context.turns;
				return { channels: [claim], surfaces: [surface] };
			},
		},
	];
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 2_000, abortGraceMs: 20 },
			...options,
		},
		plugins,
	);
	hosts.push(roundtable);
	return { roundtable, log, replies, release: hold.resolve, taken };
}

/** Starts the held turn and returns once it runs; it ends when the test calls `release`. */
async function holdATurn(s: ReturnType<typeof setup>): Promise<void> {
	await s.roundtable.run();
	void s.taken.conversations?.handle(message("hold"));
	while (!s.log.includes("start hold")) await Bun.sleep(1);
}

describe("shutdown drain", () => {
	test("a message that arrives during the drain is not run, and its channel is told the host restarts", async () => {
		const s = setup();
		await holdATurn(s);
		const stopped = s.roundtable.shutdown("SIGTERM");
		// The shutdown first lets a boot in progress settle.
		await Bun.sleep(1);
		await s.taken.conversations?.handle(message("late"));
		s.release();
		expect(await stopped).toBe(0);
		expect(s.log).toEqual(["start hold", "end hold"]);
		expect(s.replies).toHaveLength(1);
	});

	test("a background turn during the drain is skipped", async () => {
		const s = setup();
		await holdATurn(s);
		const stopped = s.roundtable.shutdown("SIGTERM");
		// The shutdown first lets a boot in progress settle.
		await Bun.sleep(1);
		const outcome = await s.taken.conversations?.background({
			channel: "fake:room",
			target: "owner",
			author: { principalId: "owner", id: "owner", name: "Riley" },
			tier: "owner",
			turnId: "report-1",
			text: "report",
			report: true,
		});
		s.release();
		await stopped;
		expect(outcome?.status).toBe("skipped");
		expect(s.log.some((line) => line.startsWith("background"))).toBe(false);
	});

	test("a turn a plugin asks the host for during the drain is refused", async () => {
		const s = setup();
		await holdATurn(s);
		const stopped = s.roundtable.shutdown("SIGTERM");
		// The shutdown first lets a boot in progress settle.
		await Bun.sleep(1);
		await expect(
			s.taken.turns?.run({
				channel: "fake:room",
				kind: "study",
				text: "report",
				speaker: OWNER_SPEAKER,
			}),
		).rejects.toBeInstanceOf(HostStoppingError);
		s.release();
		await stopped;
	});

	test("the drain ends as soon as the running turn does, without aborting it", async () => {
		const aborted: string[][] = [];
		const s = setup({
			drain: { intervalMs: 1, limitMs: 60_000, abortGraceMs: 20 },
			aborted: async (left) => void aborted.push(left),
		});
		await holdATurn(s);
		const stopped = s.roundtable.shutdown("SIGTERM");
		// The shutdown first lets a boot in progress settle.
		await Bun.sleep(1);
		await Bun.sleep(30);
		const before = Date.now();
		s.release();
		expect(await stopped).toBe(0);
		expect(Date.now() - before).toBeLessThan(1_000);
		expect(aborted).toEqual([]);
		expect(s.log).toEqual(["start hold", "end hold"]);
	});

	test("at the limit a hung turn is stopped and handed over, and the shutdown goes on", async () => {
		const aborted: string[][] = [];
		const s = setup({
			drain: { intervalMs: 1, limitMs: 50, abortGraceMs: 20 },
			aborted: async (left) => void aborted.push(left),
		});
		await holdATurn(s);
		expect(await s.roundtable.shutdown("SIGTERM")).toBe(0);
		expect(s.log).toEqual(["start hold", "stop fake:room"]);
		expect(aborted).toEqual([["fake:room"]]);
		s.release();
	});
});
