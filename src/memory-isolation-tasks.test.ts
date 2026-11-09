import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	type FauxContentBlock,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { HeldActionStore } from "./core/contract/runtime.ts";
import type {
	ChannelKey,
	PendingConfirmation,
} from "./core/domain/conversation.ts";
import type { Speaker } from "./core/identity/speakers.ts";
import {
	ANN,
	asSent,
	BO,
	call,
	dirs,
	HIDDEN,
	isolationHost,
	OWNER,
	privateTo,
	SECRETS,
	STORE,
	SYSTEM,
} from "./fixtures/memory-isolation.ts";

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("a task beside a turn", () => {
	test("works under its conversation's memory policy: a persona without memory gives its worker none", async () => {
		let worker: TranscriptContext | undefined;
		const host = await isolationHost(STORE(), [
			call("probe_task", {}),
			(context) => {
				worker = context;
				return fauxAssistantMessage("Found nothing.");
			},
			fauxAssistantMessage("Done."),
		]);
		try {
			expect(
				(
					await host.run(ANN, "fake:quiz", {
						conversation: privateTo("ann"),
						kind: "quiz",
					})
				).ok,
			).toBe(true);
			if (!worker) throw new Error("the worker asked nothing");
			for (const sent of asSent(worker)) {
				expect(sent).not.toContain("ANN_CORE_SECRET");
				expect(sent).not.toContain("memory_search");
			}
		} finally {
			await host.stop();
		}
	});
});

describe("a task beside a turn in a shared conversation", () => {
	test("its result, which the worker drew from the reader's memory, reaches no one else's request", async () => {
		const seen: TranscriptContext[] = [];
		const look: FauxResponseStep = (context) => {
			seen.push(context);
			return fauxAssistantMessage("OK.");
		};
		const host = await isolationHost(STORE(), [
			// Ann's turn hands a worker the lookup; the worker searches her memory and reports it.
			call("probe_task", {}),
			call("memory_search", { query: "doctor" }),
			(context) => {
				const found = context.messages.findLast((m) => m.role === "toolResult");
				return fauxAssistantMessage(
					`Found: ${found?.role === "toolResult" ? JSON.stringify(found.content) : "nothing"}`,
				);
			},
			look,
			look,
			look,
			look,
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [ann] = seen.splice(0);
			if (!ann) throw new Error("Ann's turn asked nothing after its task");
			// The worker's report holds her note, in her own turn.
			expect(JSON.stringify(ann.messages)).toContain("ANN_NOTE_SECRET");
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(true);
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [bo, system, again] = seen;
			if (!bo || !system || !again) throw new Error("a turn asked nothing");
			for (const request of [bo, system])
				for (const sent of asSent(request)) {
					for (const secret of SECRETS) expect(sent).not.toContain(secret);
					expect(sent).toContain(HIDDEN);
				}
			for (const sent of asSent(again)) {
				expect(sent).toContain("ANN_NOTE_SECRET");
				expect(sent).not.toContain(HIDDEN);
			}
		} finally {
			await host.stop();
		}
	});
});

describe("what a conversation held when it comes to serve someone else", () => {
	test("is dropped with its archived history, after a restart too, so no one approves the old scope's action", async () => {
		const stored = new Map<ChannelKey, PendingConfirmation>();
		const held: HeldActionStore = {
			load: async (key) => stored.get(key),
			save: async (key, actions) => {
				if (actions) stored.set(key, actions);
				else stored.delete(key);
			},
		};
		const first = await isolationHost(
			STORE(),
			[
				call("deploy", { site: "ann-site" }),
				fauxAssistantMessage("Waiting for approval."),
			],
			{ held },
		);
		try {
			expect(
				(await first.run(ANN, "fake:desk", { conversation: privateTo("ann") }))
					.ok,
			).toBe(true);
		} finally {
			await first.stop();
		}
		expect(stored.get("fake:desk")?.calls[0]?.action).toBe("deploy ann-site");
		const seen: TranscriptContext[] = [];
		const again = await isolationHost(
			STORE(),
			[
				(context) => {
					seen.push(context);
					return call("deploy", { site: "ann-site" });
				},
				fauxAssistantMessage("Done."),
			],
			{ dir: first.dir, held },
		);
		const owner: Speaker = {
			id: OWNER.id,
			name: OWNER.name,
			tier: "owner",
			principalId: OWNER.id,
		};
		try {
			expect(
				(
					await again.run(owner, "fake:desk", {
						conversation: privateTo(OWNER.id),
						confirmed: true,
						text: "Go ahead.",
					})
				).ok,
			).toBe(true);
			expect(again.deployed).toEqual([]);
			expect(JSON.stringify(seen[0]?.messages)).not.toContain("ann-site");
			// The model's new call is held anew, for the owner's turn, not released as Ann's.
			expect(stored.get("fake:desk")?.principalId).toBe(OWNER.id);
		} finally {
			await again.stop();
		}
	});
});

describe("the reasoning of a shared conversation's earlier turns", () => {
	/** An answer that thinks first, its reasoning also carried as a provider's encrypted signature. */
	const thinking = (thought: string, then: FauxContentBlock) =>
		fauxAssistantMessage(
			[
				{
					type: "thinking",
					thinking: thought,
					thinkingSignature: `${thought}_SIGNED`,
				},
				then,
			],
			{ stopReason: then.type === "toolCall" ? "toolUse" : "stop" },
		);

	test("reaches no later turn's request, while a turn keeps its own as it goes", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(STORE(), [
			thinking("ANN_THOUGHT_SECRET", fauxText("Noted.")),
			(context) => {
				seen.push(context);
				return thinking("BO_THOUGHT", {
					...fauxToolCall("memory_search", { query: "chemistry" }),
					thoughtSignature: "BO_TOOL_SIGNED",
				});
			},
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("OK.");
			},
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("OK.");
			},
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(true);
			const [bo, boAgain, system] = seen;
			if (!bo || !boAgain || !system) throw new Error("a turn asked nothing");
			for (const request of [bo, boAgain, system])
				for (const sent of asSent(request)) {
					expect(sent).not.toContain("ANN_THOUGHT_SECRET");
					expect(sent).toContain("Noted.");
				}
			// Bo's turn, after its tool call, still reads the reasoning it gave for the call.
			for (const sent of asSent(boAgain)) {
				expect(sent).toContain("BO_THOUGHT_SIGNED");
				expect(sent).toContain("BO_TOOL_SIGNED");
			}
			for (const sent of asSent(system)) {
				expect(sent).not.toContain("BO_THOUGHT");
				expect(sent).not.toContain("BO_TOOL_SIGNED");
			}
		} finally {
			await host.stop();
		}
	});
});

describe("a shared conversation's compaction", () => {
	/** A message long enough that the turn after it compacts the history before it. */
	const LONG = `${"Bo reads a long text. ".repeat(16_000)}`;
	const thought = {
		type: "thinking" as const,
		thinking: "ANN_THOUGHT_SECRET",
		thinkingSignature: "ANN_SIGNED_SECRET",
	};
	/** Ann's turn finds her note, thinking aloud; Bo's then fills the context. */
	const turns = (): FauxResponseStep[] => [
		fauxAssistantMessage(
			[thought, fauxToolCall("memory_search", { query: "doctor" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Noted."),
		fauxAssistantMessage("Read it."),
	];
	const PRIVATE = [...SECRETS, "ANN_THOUGHT_SECRET", "ANN_SIGNED_SECRET"];

	test("Pi's own summary is written from the history without anyone's private memory", async () => {
		let summarized: string | undefined;
		const host = await isolationHost(STORE(), [
			...turns(),
			(context) => {
				summarized = JSON.stringify(context.messages);
				return fauxAssistantMessage("A summary.");
			},
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room", { text: LONG })).ok).toBe(true);
			if (!summarized) throw new Error("the history was not compacted");
			expect(summarized).toContain("Noted.");
			for (const secret of PRIVATE) expect(summarized).not.toContain(secret);
		} finally {
			await host.stop();
		}
	});

	test("a compaction extension placed through the core's wrapper is given the history without it", async () => {
		let summarized: string | undefined;
		const host = await isolationHost(STORE(), turns(), {
			compactor: (text) => {
				summarized = text;
			},
		});
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room", { text: LONG })).ok).toBe(true);
			if (!summarized) throw new Error("the history was not compacted");
			expect(summarized).toContain("Noted.");
			for (const secret of PRIVATE) expect(summarized).not.toContain(secret);
			expect(summarized).toContain(HIDDEN);
		} finally {
			await host.stop();
		}
	});
});
