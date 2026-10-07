import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../contract/runtime.ts";
import type { SurfacePort } from "../contract/surface.ts";
import type { TurnResult } from "../domain/conversation.ts";
import type { TurnRequest } from "../domain/ports.ts";
import { NotLinkedError, PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import type { TurnEndEvent, TurnEvent, TurnProgressEvent } from "../plugin.ts";
import { useTestLocale } from "../testing/locale.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { conversationTurns } from "./conversation-turns.ts";

beforeEach(useTestLocale);

/** A surface that records what the turn showed and posted, in order. */
function recordingSurface(log: string[]): SurfacePort {
	return {
		of: () => undefined,
		sendReply: async (channel, reply) => {
			log.push(`reply ${channel} ${JSON.stringify(reply)}`);
		},
		startTyping: (channel) => {
			log.push(`typing ${channel}`);
			return () => void log.push(`typing done ${channel}`);
		},
		showStop: (channel) => {
			log.push(`stop ${channel}`);
			return () => void log.push(`stop done ${channel}`);
		},
		react: async () => undefined,
		unreact: async () => undefined,
		prompts: () => undefined,
		interim: () => undefined,
		progress: async (channel, event) =>
			void log.push(`progress ${channel} ${JSON.stringify(event)}`),
	};
}

function setup(run: (request: TurnRequest) => Promise<TurnResult>) {
	const log: string[] = [];
	const requests: TurnRequest[] = [];
	const events: (TurnEvent | TurnEndEvent)[] = [];
	const progress: TurnProgressEvent[] = [];
	const runtime = {
		runTurn: async (request: TurnRequest) => {
			requests.push(request);
			log.push("run");
			return run(request);
		},
	} as unknown as AgentRuntime;
	const turns = conversationTurns({
		linked: () => undefined,
		runtime: () => runtime,
		surfaces: recordingSurface(log),
		events: {
			turnStarted: (turn) => {
				log.push("started");
				events.push(turn);
			},
			turnEnded: (turn) => {
				log.push(`ended ${turn.result}`);
				events.push(turn);
			},
			turnProgress: (event) => void progress.push(event),
			changed: () => undefined,
		},
		selection: () => ({ tools: ["note_add"], groups: ["mail"] }),
		logger: silentLogger(),
	});
	return { turns, log, requests, events, progress };
}

const input = {
	channel: "fake:room",
	kind: "study",
	text: "hello",
	speaker: OWNER_SPEAKER,
} as const;

describe("conversation turns", () => {
	test("shows typing and stop, runs the turn as its kind, and posts the answer through the surface", async () => {
		const { turns, log, requests } = setup(async () => ({
			ok: true,
			text: "Hi there",
		}));
		const result = await turns.run(input);
		expect(result).toEqual({ ok: true, text: "Hi there" });
		expect(requests).toEqual([
			{
				channel: "fake:room",
				kind: "study",
				// The plugins' agent selection, read at the turn.
				selection: { id: "turns", tools: ["note_add"], groups: ["mail"] },
				text: "hello",
				speaker: OWNER_SPEAKER,
				progress: expect.any(Function),
			},
		]);
		expect(log).toEqual([
			"typing fake:room",
			"stop fake:room",
			"started",
			"run",
			"stop done fake:room",
			"ended ok",
			`reply fake:room ${JSON.stringify({ chunks: ["Hi there"] })}`,
			"typing done fake:room",
		]);
	});

	test("what the runtime reports as the turn goes reaches the surface and the plugins' handlers, until the turn ends", async () => {
		let late: TurnRequest["progress"];
		const { turns, log, progress } = setup(async (request) => {
			request.progress?.({ type: "text", delta: "Looking" });
			request.progress?.({
				type: "tool_start",
				id: "c1",
				tool: "probe",
				preview: "{}",
			});
			request.progress?.({
				type: "tool_end",
				id: "c1",
				tool: "probe",
				ok: true,
			});
			late = request.progress;
			return { ok: true, text: "done" };
		});
		await turns.run(input);
		late?.({ type: "text", delta: "after the end" });
		expect(log.filter((line) => line.startsWith("progress"))).toEqual([
			'progress fake:room {"type":"text","delta":"Looking"}',
			'progress fake:room {"type":"tool_start","id":"c1","tool":"probe","preview":"{}"}',
			'progress fake:room {"type":"tool_end","id":"c1","tool":"probe","ok":true}',
		]);
		expect(log.indexOf("started")).toBeLessThan(
			log.findIndex((line) => line.startsWith("progress")),
		);
		expect(progress).toEqual([
			{
				kind: "study",
				channel: "fake:room",
				speaker: OWNER_SPEAKER,
				progress: { type: "text", delta: "Looking" },
			},
			{
				kind: "study",
				channel: "fake:room",
				speaker: OWNER_SPEAKER,
				progress: {
					type: "tool_start",
					id: "c1",
					tool: "probe",
					preview: "{}",
				},
			},
			{
				kind: "study",
				channel: "fake:room",
				speaker: OWNER_SPEAKER,
				progress: { type: "tool_end", id: "c1", tool: "probe", ok: true },
			},
		]);
	});

	test("the turn's options reach the runtime, and a selection of its own replaces the default", async () => {
		const { turns, requests } = setup(async () => ({ ok: true, text: "ok" }));
		const attachments = { files: [], images: [], failures: [] };
		await turns.run({
			...input,
			attachments,
			selection: { id: "mine", tools: [], groups: [] },
			steerable: true,
			interactive: true,
			confirmed: true,
		});
		expect(requests[0]).toEqual({
			progress: expect.any(Function),
			channel: "fake:room",
			kind: "study",
			selection: { id: "mine", tools: [], groups: [] },
			text: "hello",
			speaker: OWNER_SPEAKER,
			attachments,
			confirmed: true,
			steerable: true,
			interactive: true,
		});
	});

	test("turnStarted and turnEnded carry the kind and no agent", async () => {
		const { turns, events } = setup(async () => ({ ok: true, text: "ok" }));
		await turns.run(input);
		expect(events).toEqual([
			{ kind: "study", channel: "fake:room", speaker: OWNER_SPEAKER },
			{
				kind: "study",
				channel: "fake:room",
				speaker: OWNER_SPEAKER,
				result: "ok",
			},
		]);
	});

	test("a runtime that throws is settled into a failed result with the failure notice", async () => {
		const { turns, log, events } = setup(async () => {
			throw new Error("socket closed");
		});
		const result = await turns.run(input);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.message).toBe(
			"conversation turn crashed: Error: socket closed",
		);
		expect(events.at(-1)).toMatchObject({ result: "failed" });
		expect(log.at(-2)).toContain("reply fake:room");
		expect(log.at(-2)).toContain("this reply did not go through");
		// The controls are hidden and typing stops even though the turn failed.
		expect(log).toContain("stop done fake:room");
		expect(log.at(-1)).toBe("typing done fake:room");
	});

	test("a stopped turn posts the stopped notice", async () => {
		const { turns, log, events } = setup(async () => ({
			ok: false,
			error: new Error("stopped"),
			stopped: true,
		}));
		const result = await turns.run(input);
		expect(result).toMatchObject({ ok: false, stopped: true });
		expect(events.at(-1)).toMatchObject({ result: "stopped" });
		expect(log.at(-2)).toBe(
			`reply fake:room ${JSON.stringify({ chunks: ["-# Stopped."] })}`,
		);
	});

	test("the thinking of an answer goes out as its quiet line", async () => {
		const { turns, log } = setup(async () => ({
			ok: true,
			text: "Hi",
			thinking: "Considering.",
		}));
		await turns.run(input);
		expect(log.at(-2)).toBe(
			`reply fake:room ${JSON.stringify({ thinking: "-# Considering.", chunks: ["Hi"] })}`,
		);
	});

	test("a reply of the claim's own replaces the surface post, and a throw in it is logged, not thrown", async () => {
		const { turns, log } = setup(async () => ({ ok: true, text: "Hi" }));
		const seen: TurnResult[] = [];
		await turns.run({
			...input,
			reply: async (result) => {
				seen.push(result);
			},
		});
		expect(seen).toEqual([{ ok: true, text: "Hi" }]);
		expect(log.some((line) => line.startsWith("reply "))).toBe(false);
		const result = await turns.run({
			...input,
			reply: async () => {
				throw new Error("cannot post");
			},
		});
		expect(result).toEqual({ ok: true, text: "Hi" });
		expect(log.at(-1)).toBe("typing done fake:room");
	});

	test("a surface that cannot post does not turn the answer into a failure", async () => {
		const { turns } = setup(async () => ({ ok: true, text: "Hi" }));
		const broken = conversationTurns({
			linked: () => undefined,
			runtime: () =>
				({
					runTurn: async () => ({ ok: true, text: "Hi" }),
				}) as unknown as AgentRuntime,
			surfaces: {
				...recordingSurface([]),
				sendReply: async () => {
					throw new PluginError("no chat surface serves the channel");
				},
			},
			events: {
				turnStarted: () => undefined,
				turnEnded: () => undefined,
				changed: () => undefined,
			},
			selection: () => ({ tools: [], groups: [] }),
			logger: silentLogger(),
		});
		expect(await broken.run(input)).toEqual({ ok: true, text: "Hi" });
		expect(await turns.run(input)).toEqual({ ok: true, text: "Hi" });
	});

	test("before linking, and on a host without a runtime, it rejects before showing anything", async () => {
		const log: string[] = [];
		const base = {
			surfaces: recordingSurface(log),
			events: {
				turnStarted: () => undefined,
				turnEnded: () => undefined,
				changed: () => undefined,
			},
			selection: () => ({ tools: [], groups: [] }),
			logger: silentLogger(),
		};
		const early = conversationTurns({
			...base,
			linked: () => {
				throw new NotLinkedError("not linked yet");
			},
			runtime: () => {
				throw new Error("not read");
			},
		});
		await expect(early.run(input)).rejects.toBeInstanceOf(NotLinkedError);
		const bare = conversationTurns({
			...base,
			linked: () => undefined,
			runtime: () => {
				throw new PluginError("core service agents is not provided yet.");
			},
		});
		await expect(bare.run(input)).rejects.toBeInstanceOf(PluginError);
		expect(log).toEqual([]);
	});
});
