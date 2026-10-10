import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../contract/runtime.ts";
import type { SurfacePort } from "../contract/surface.ts";
import type {
	ConversationRegistration,
	ConversationRegistry,
} from "../conversations/conversation-registry.ts";
import type { TurnResult } from "../domain/conversation.ts";
import type { TurnRequest } from "../domain/ports.ts";
import { HostStoppingError, NotLinkedError, PluginError } from "../errors.ts";
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

function setup(
	run: (request: TurnRequest) => Promise<TurnResult>,
	registry?: Pick<ConversationRegistry, "register">,
	surfaces: (log: string[]) => SurfacePort = recordingSurface,
) {
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
		surfaces: surfaces(log),
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
		...(registry ? { registry: () => registry } : {}),
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

	test("a surface port written before progress existed still runs the turn, and the handlers still hear its progress", async () => {
		const { turns, log, progress } = setup(
			async (request) => {
				request.progress?.({ type: "text", delta: "Looking" });
				return { ok: true, text: "done" };
			},
			undefined,
			(log) => {
				const { progress: _progress, ...older } = recordingSurface(log);
				return older;
			},
		);
		expect(await turns.run(input)).toEqual({ ok: true, text: "done" });
		expect(log).toContain("ended ok");
		expect(progress.map((event) => event.progress)).toEqual([
			{ type: "text", delta: "Looking" },
		]);
	});

	test("each turn records its conversation before it runs: shared by default, private to the speaker when asked", async () => {
		const registered: ConversationRegistration[] = [];
		const registry = {
			register: async (entry: ConversationRegistration) => {
				registered.push(entry);
				return {
					...entry,
					surface: "fake",
					createdAt: new Date(),
					lastActiveAt: new Date(),
				};
			},
		};
		const { turns, log } = setup(async () => ({ ok: true, text: "hi" }), {
			register: async (entry) => {
				log.push("registered");
				return registry.register(entry);
			},
		});
		await turns.run(input);
		await turns.run({
			...input,
			channel: "fake:mine",
			conversation: { visibility: "private", title: "Algebra" },
		});
		expect(registered).toEqual([
			{ key: "fake:room", kind: "study", visibility: "shared" },
			{
				key: "fake:mine",
				kind: "study",
				visibility: "private",
				principalId: OWNER_SPEAKER.id,
				title: "Algebra",
			},
		]);
		expect(log.indexOf("registered")).toBeLessThan(log.indexOf("run"));
	});

	test("a private conversation is its speaker's principal's, not their surface id's", async () => {
		const registered: ConversationRegistration[] = [];
		const { turns } = setup(async () => ({ ok: true, text: "hi" }), {
			register: async (entry) => {
				registered.push(entry);
				return {
					...entry,
					surface: "fake",
					createdAt: new Date(),
					lastActiveAt: new Date(),
				};
			},
		});
		await turns.run({
			...input,
			channel: "fake:mine",
			speaker: { ...OWNER_SPEAKER, id: "surface-id", principalId: "p_owner" },
			conversation: { visibility: "private" },
		});
		expect(registered.map((entry) => entry.principalId)).toEqual(["p_owner"]);
	});

	test("the conversation as its record keeps it reaches the runtime, so a private one stays its principal's at every turn", async () => {
		const stored = new Map<string, ConversationRegistration>();
		const { turns, requests } = setup(async () => ({ ok: true, text: "hi" }), {
			register: async (entry) => {
				const kept = stored.get(entry.key) ?? entry;
				stored.set(entry.key, kept);
				return {
					...kept,
					surface: "fake",
					createdAt: new Date(),
					lastActiveAt: new Date(),
				};
			},
		});
		const mine = {
			...input,
			channel: "fake:mine",
			speaker: { ...OWNER_SPEAKER, principalId: "p_owner" },
		} as const;
		await turns.run({ ...mine, conversation: { visibility: "private" } });
		await turns.run(mine);
		await turns.run(input);
		expect(requests.map((request) => request.conversation)).toEqual([
			{ visibility: "private", principalId: "p_owner" },
			{ visibility: "private", principalId: "p_owner" },
			{ visibility: "shared" },
		]);
		// Without a registry, the turn's own word is all there is.
		const bare = setup(async () => ({ ok: true, text: "hi" }));
		await bare.turns.run({ ...mine, conversation: { visibility: "private" } });
		await bare.turns.run(mine);
		expect(bare.requests.map((request) => request.conversation)).toEqual([
			{ visibility: "private", principalId: "p_owner" },
			undefined,
		]);
	});

	test("a private conversation runs only its principal's turns and the host's own, refusing anyone else's before the turn starts", async () => {
		const stored = new Map<string, ConversationRegistration>();
		const { turns, log, requests } = setup(
			async () => ({ ok: true, text: "hi" }),
			{
				register: async (entry) => {
					const kept = stored.get(entry.key) ?? entry;
					stored.set(entry.key, kept);
					return {
						...kept,
						surface: "fake",
						createdAt: new Date(),
						lastActiveAt: new Date(),
					};
				},
			},
		);
		const mine = { ...input, channel: "fake:mine" } as const;
		await turns.run({ ...mine, conversation: { visibility: "private" } });
		const ann = {
			id: "ann",
			name: "Ann",
			tier: "owner",
			principalId: "p_ann",
		} as const;
		await expect(turns.run({ ...mine, speaker: ann })).rejects.toThrow(
			`fake:mine is private to ${OWNER_SPEAKER.principalId}`,
		);
		await expect(
			turns.run({
				...mine,
				speaker: ann,
				conversation: { visibility: "private" },
			}),
		).rejects.toThrow("is private to");
		await turns.run({
			...mine,
			speaker: { ...ann, id: "assistant", principalId: "system" },
		});
		expect(requests.map((request) => request.speaker.principalId)).toEqual([
			OWNER_SPEAKER.principalId,
			"system",
		]);
		expect(log.filter((line) => line === "started")).toHaveLength(2);
	});

	test("a private conversation needs the speaker it belongs to, and a failed record runs no turn", async () => {
		const { turns, log } = setup(async () => ({ ok: true, text: "hi" }), {
			register: async () => {
				throw new Error("database down");
			},
		});
		await expect(
			turns.run({
				channel: "fake:mine",
				kind: "study",
				text: "hello",
				speaker: undefined as never,
				conversation: { visibility: "private" },
			}),
		).rejects.toThrow("a private conversation needs the speaker");
		await expect(turns.run(input)).rejects.toThrow("database down");
		expect(log).not.toContain("run");
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
	test("no turn starts once the host is shutting down, and nothing is shown for it", async () => {
		const log: string[] = [];
		let stopping = false;
		const turns = conversationTurns({
			linked: () => undefined,
			stopping: () => stopping,
			runtime: () =>
				({
					runTurn: async () => {
						log.push("ran");
						return { ok: true, text: "Hi" };
					},
				}) as unknown as AgentRuntime,
			surfaces: recordingSurface(log),
			events: {
				turnStarted: () => void log.push("started"),
				turnEnded: () => undefined,
				changed: () => undefined,
			},
			selection: () => ({ tools: [], groups: [] }),
			logger: silentLogger(),
		});
		expect(await turns.run(input)).toEqual({ ok: true, text: "Hi" });
		log.length = 0;
		stopping = true;
		await expect(turns.run(input)).rejects.toBeInstanceOf(HostStoppingError);
		expect(log).toEqual([]);
	});
});
