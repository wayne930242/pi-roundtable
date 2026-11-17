import { afterEach, describe, expect, test } from "bun:test";
import type {
	ChannelClaim,
	ConversationPort,
	InboundMessage,
} from "../contract/channels.ts";
import type { AgentRuntime } from "../contract/runtime.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { ConversationRegistry } from "../conversations/conversation-registry.ts";
import type { TurnResult } from "../domain/conversation.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { silentLogger } from "../kernel/log.ts";
import type { RoundtablePlugin } from "../plugin-api/plugin.ts";
import { CONVERSATIONS, RUNTIME } from "../plugin-api/services.ts";
import type { ConversationTurns } from "../routing/conversation-turns.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { Roundtable } from "./host.ts";

const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
});

const ROOM: ChannelKey = "fake:room";

function message(id: string): InboundMessage {
	return {
		channel: ROOM,
		messageId: id,
		authorId: "owner",
		authorName: "Riley",
		authorIsBot: false,
		isDirect: true,
		mentionsBot: false,
		repliesToBot: false,
		text: id,
		attachments: [],
	};
}

/**
 * How the runtime's running turn takes `stop`: `obeys` ends it stopped at once, `told` says it was
 * told and keeps it running, as a turn about to answer does, and `deaf` keeps it running and says
 * none was stopped, as when the stop does not reach it.
 */
type Stopping = "obeys" | "told" | "deaf";

/**
 * A host with one plugin claim that has no `stop` and runs each message's turn through
 * `context.turns` on a runtime whose turn runs until the test ends it or the host stops it. The
 * surface takes every refused message, as the Discord surface does with catch-up, and `log`
 * records what was left and when the services stopped.
 */
function setup(
	stopping: Stopping,
	steers = false,
	graceMs = 40,
	awaits = true,
) {
	const log: string[] = [];
	const replies: string[] = [];
	const stops: string[] = [];
	const turns: { resolve(result: TurnResult): void }[] = [];
	const taken: { conversations?: ConversationPort; turns?: ConversationTurns } =
		{};
	const runtime = {
		runTurn: () =>
			new Promise<TurnResult>((resolve) => {
				turns.push({ resolve });
			}),
		stop: (channel: ChannelKey) => {
			stops.push(channel);
			if (stopping !== "obeys") return stopping === "told";
			for (const turn of turns.splice(0))
				turn.resolve({ ok: false, error: new Error("stopped"), stopped: true });
			return true;
		},
	} as unknown as AgentRuntime;
	const claim: ChannelClaim = {
		name: "plain",
		priority: 0,
		owns: (channel) => channel.startsWith("fake:"),
		admit: (m) => ({
			kind: "turn",
			busy: {
				steer: async () => steers,
				react: async () => undefined,
				unreact: async () => undefined,
			},
			run: async () => {
				const turn = taken.turns?.run({
					channel: m.channel,
					kind: "plain",
					text: m.text,
					speaker: OWNER_SPEAKER,
				});
				if (awaits) await turn;
				else void turn?.catch(() => undefined);
			},
			failure: "failed",
		}),
		startFresh: async () => "plain",
	};
	const surface: ChatSurface = {
		surface: "fake",
		start: async () => undefined,
		sendReply: async (_channel, reply) =>
			void replies.push(reply.chunks.join("")),
		refuseStopping: async (m) => {
			log.push(`left ${m.messageId}`);
			return true;
		},
	};
	const plugins: RoundtablePlugin[] = [
		{
			name: "runtime",
			provides: [RUNTIME, CONVERSATIONS],
			setup: (context) => {
				context.services.provide(RUNTIME, runtime);
				// Recording a conversation takes a moment, as the database does, before its turn starts.
				context.services.provide(CONVERSATIONS, {
					register: async (entry: { key: string; kind: string }) => {
						await Bun.sleep(5);
						return { ...entry, visibility: "shared" };
					},
				} as unknown as ConversationRegistry);
				return {
					services: [
						{ name: "runtime", stop: () => void log.push("stop runtime") },
					],
				};
			},
		},
		{
			name: "plain",
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
			drain: { intervalMs: 1, limitMs: 40, abortGraceMs: graceMs },
		},
		plugins,
	);
	hosts.push(roundtable);
	return { roundtable, log, replies, stops, turns, taken };
}

async function until(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await Bun.sleep(1);
	}
}

/** Starts the turn of `first` and returns once the runtime runs it. */
async function holdATurn(s: ReturnType<typeof setup>): Promise<void> {
	await s.roundtable.run();
	void s.taken.conversations?.handle(message("first"));
	await until(() => s.turns.length > 0);
}

describe("a turn the shutdown cuts", () => {
	test("is stopped through the runtime when its claim has no stop, and its message is left before the services stop", async () => {
		const s = setup("obeys");
		await holdATurn(s);
		expect(await s.roundtable.shutdown("SIGTERM")).toBe(0);
		expect(s.stops[0]).toBe(ROOM);
		expect(s.log).toEqual(["left first", "stop runtime"]);
	});

	test("still running when the grace ends is left too, and the answer it gives later is not posted", async () => {
		const s = setup("deaf");
		await holdATurn(s);
		expect(await s.roundtable.shutdown("SIGTERM")).toBe(0);
		expect(s.log).toEqual(["left first", "stop runtime"]);
		s.turns[0]?.resolve({ ok: true, text: "the answer" });
		// Its pipeline posts the stopped notice in its place.
		await until(() => s.replies.length > 0);
		expect(s.replies).toEqual(["-# Stopped."]);
	});

	test("that answers within the grace is not left", async () => {
		// A long grace, which the drain ends as soon as the turn does.
		const s = setup("told", false, 5_000);
		await holdATurn(s);
		const stopped = s.roundtable.shutdown("SIGTERM");
		// Past the drain limit, within the grace.
		await until(() => s.stops.length > 0);
		s.turns[0]?.resolve({ ok: true, text: "the answer" });
		expect(await stopped).toBe(0);
		expect(s.log).toEqual(["stop runtime"]);
		expect(s.replies).toEqual(["the answer"]);
	});

	test("leaves the messages steered into it, and before those waiting behind it", async () => {
		const steered = setup("obeys", true);
		await holdATurn(steered);
		await steered.taken.conversations?.handle(message("steered"));
		expect(await steered.roundtable.shutdown("SIGTERM")).toBe(0);
		expect(steered.log).toEqual(["left first", "left steered", "stop runtime"]);
		const waiting = setup("deaf");
		await holdATurn(waiting);
		void waiting.taken.conversations?.handle(message("waiting"));
		await until(() => waiting.taken.conversations?.queued?.(ROOM).length === 1);
		expect(await waiting.roundtable.shutdown("SIGTERM")).toBe(0);
		expect(waiting.log).toEqual(["left first", "left waiting", "stop runtime"]);
	});
	test("that its admission started without waiting for it, outside the queue the drain waits for, is left as well, and its late answer is not posted", async () => {
		const s = setup("obeys", false, 40, false);
		await holdATurn(s);
		expect(await s.roundtable.shutdown("SIGTERM")).toBe(0);
		expect(s.log).toEqual(["left first", "stop runtime"]);
		s.turns[0]?.resolve({ ok: true, text: "the answer" });
		await until(() => s.replies.length > 0);
		expect(s.replies).toEqual(["-# Stopped."]);
	});
});
