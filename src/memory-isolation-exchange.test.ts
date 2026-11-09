import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { MemoryStore } from "./core/plugin-api/services.ts";
import {
	ANN,
	asSent,
	BO,
	call,
	dirs,
	HIDDEN,
	isolationHost,
	QUEUE,
	SECRETS,
	STORE,
	SYSTEM,
} from "./fixtures/memory-isolation.ts";

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("what the model writes into a memory exchange's call", () => {
	/** The placeholder a hidden call's arguments read as. */
	const HIDDEN_CALL = { hidden: HIDDEN };

	test("reaches no one else's request, a worker's call that loaded the reader's memory included, while Ann's own next turn still reads it", async () => {
		const seen: TranscriptContext[] = [];
		const look: FauxResponseStep = (context) => {
			seen.push(context);
			return fauxAssistantMessage("OK.");
		};
		const host = await isolationHost(STORE(), [
			// Ann only says hello; the model copies her memory into the calls it makes.
			call("memory_add", { fact: "ANN_CORE_SECRET again", kind: "note" }),
			call("memory_remove", { text: "ANN_NOTE_SECRET is gone" }),
			call("probe_task", { topic: "ANN_CORE_SECRET lookup" }),
			call("memory_search", { query: "doctor" }),
			fauxAssistantMessage("Found it."),
			fauxAssistantMessage("Noted."),
			look,
			look,
			look,
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(true);
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [bo, system, again] = seen;
			if (!bo || !system || !again) throw new Error("a turn asked nothing");
			for (const request of [bo, system]) {
				for (const sent of asSent(request))
					for (const secret of SECRETS) expect(sent).not.toContain(secret);
				// Each call stays a call the provider accepts, its arguments a placeholder.
				const calls = request.messages.flatMap((message) =>
					message.role === "assistant"
						? message.content.filter((part) => part.type === "toolCall")
						: [],
				);
				expect(calls.map((part) => part.name)).toEqual([
					"memory_add",
					"memory_remove",
					"probe_task",
				]);
				for (const part of calls) expect(part.arguments).toEqual(HIDDEN_CALL);
			}
			for (const sent of asSent(again)) {
				expect(sent).toContain("ANN_CORE_SECRET again");
				expect(sent).toContain("ANN_NOTE_SECRET is gone");
				expect(sent).toContain("ANN_CORE_SECRET lookup");
			}
		} finally {
			await host.stop();
		}
	});

	test("reaches no compaction's summary", async () => {
		const LONG = `${"Bo reads a long text. ".repeat(16_000)}`;
		const turns = (): FauxResponseStep[] => [
			call("memory_add", { fact: "ANN_CORE_SECRET again", kind: "note" }),
			fauxAssistantMessage("Noted."),
			fauxAssistantMessage("Read it."),
		];
		let summarized: string | undefined;
		const own = await isolationHost(STORE(), [
			...turns(),
			(context) => {
				summarized = JSON.stringify(context.messages);
				return fauxAssistantMessage("A summary.");
			},
		]);
		let wrapped: string | undefined;
		const placed = await isolationHost(STORE(), turns(), {
			compactor: (text) => {
				wrapped = text;
			},
		});
		try {
			for (const host of [own, placed]) {
				expect((await host.run(ANN, "fake:room")).ok).toBe(true);
				expect((await host.run(BO, "fake:room", { text: LONG })).ok).toBe(true);
			}
			for (const text of [summarized, wrapped]) {
				if (!text) throw new Error("the history was not compacted");
				expect(text).toContain("Noted.");
				expect(text).toContain("memory_add");
				expect(text).not.toContain("ANN_CORE_SECRET");
			}
		} finally {
			await own.stop();
			await placed.stop();
		}
	});
});

describe("a memory exchange that failed", () => {
	/** Ann's memory over a store that cannot write, as when its database is down. */
	const failing = (): MemoryStore => {
		const store = STORE();
		return {
			forSpeaker: (id) => ({
				...store.forSpeaker(id),
				add: async () => {
					throw new Error("DB_UNAVAILABLE");
				},
			}),
		};
	};
	const look =
		(seen: TranscriptContext[]): FauxResponseStep =>
		(context) => {
			seen.push(context);
			return fauxAssistantMessage("OK.");
		};

	test("reaches no one else's request, while Ann's own next turn still reads her exchange", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(failing(), [
			call("memory_add", { fact: "ANN_CORE_SECRET again", kind: "note" }),
			fauxAssistantMessage("Noted."),
			look(seen),
			look(seen),
			look(seen),
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(true);
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [bo, system, again] = seen;
			if (!bo || !system || !again) throw new Error("a turn asked nothing");
			for (const request of [bo, system])
				for (const sent of asSent(request)) {
					for (const secret of SECRETS) expect(sent).not.toContain(secret);
					expect(sent).toContain("memory_add");
				}
			for (const sent of asSent(again)) {
				expect(sent).toContain("ANN_CORE_SECRET again");
				expect(sent).toContain("DB_UNAVAILABLE");
			}
		} finally {
			await host.stop();
		}
	});

	test("as its arguments were refused, reaches no one else's request", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(STORE(), [
			call("memory_add", { fact: "ANN_CORE_SECRET again", kind: "secret" }),
			fauxAssistantMessage("Noted."),
			look(seen),
			look(seen),
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(true);
			for (const request of seen)
				for (const sent of asSent(request))
					for (const secret of SECRETS) expect(sent).not.toContain(secret);
		} finally {
			await host.stop();
		}
	});

	test("reaches no compaction's summary", async () => {
		const LONG = `${"Bo reads a long text. ".repeat(16_000)}`;
		const turns = (): FauxResponseStep[] => [
			call("memory_add", { fact: "ANN_CORE_SECRET again", kind: "note" }),
			fauxAssistantMessage("Noted."),
			fauxAssistantMessage("Read it."),
		];
		let summarized: string | undefined;
		const own = await isolationHost(failing(), [
			...turns(),
			(context) => {
				summarized = JSON.stringify(context.messages);
				return fauxAssistantMessage("A summary.");
			},
		]);
		let wrapped: string | undefined;
		const placed = await isolationHost(failing(), turns(), {
			compactor: (text) => {
				wrapped = text;
			},
		});
		try {
			for (const host of [own, placed]) {
				expect((await host.run(ANN, "fake:room")).ok).toBe(true);
				expect((await host.run(BO, "fake:room", { text: LONG })).ok).toBe(true);
			}
			for (const text of [summarized, wrapped]) {
				if (!text) throw new Error("the history was not compacted");
				expect(text).toContain("Noted.");
				expect(text).toContain("memory_add");
				expect(text).not.toContain("ANN_CORE_SECRET");
			}
		} finally {
			await own.stop();
			await placed.stop();
		}
	});
});

describe("the calls a worker's memory reaches", () => {
	const look =
		(seen: TranscriptContext[]): FauxResponseStep =>
		(context) => {
			seen.push(context);
			return fauxAssistantMessage("OK.");
		};

	test("are the call that started it, not a call running beside it, whose public result Bo still reads", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(STORE(), [
			// Ann's turn waits on the public queue while a worker looks up her note.
			fauxAssistantMessage(
				[fauxToolCall("public_wait", {}), fauxToolCall("probe_task", {})],
				{ stopReason: "toolUse" },
			),
			call("memory_search", { query: "doctor" }),
			(context) => {
				const found = context.messages.findLast((m) => m.role === "toolResult");
				return fauxAssistantMessage(
					`Found: ${found?.role === "toolResult" ? JSON.stringify(found.content) : "nothing"}`,
				);
			},
			fauxAssistantMessage("Noted."),
			look(seen),
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			const [bo] = seen;
			if (!bo) throw new Error("Bo's turn asked nothing");
			for (const sent of asSent(bo)) {
				for (const secret of SECRETS) expect(sent).not.toContain(secret);
				expect(sent).toContain(QUEUE);
				expect(sent).toContain(HIDDEN);
			}
		} finally {
			await host.stop();
		}
	});

	test("are every call of the chain that started it, a worker's own task inside a task included", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(STORE(), [
			// Ann's turn hands a worker the lookup; that worker hands it to a worker of its own.
			call("probe_task", {}),
			call("probe_task", {}),
			call("memory_search", { query: "doctor" }),
			(context) => {
				const found = context.messages.findLast((m) => m.role === "toolResult");
				return fauxAssistantMessage(
					`Found: ${found?.role === "toolResult" ? JSON.stringify(found.content) : "nothing"}`,
				);
			},
			(context) => {
				const found = context.messages.findLast((m) => m.role === "toolResult");
				return fauxAssistantMessage(
					`Relayed: ${found?.role === "toolResult" ? JSON.stringify(found.content) : "nothing"}`,
				);
			},
			fauxAssistantMessage("Noted."),
			look(seen),
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(BO, "fake:room")).ok).toBe(true);
			const [bo] = seen;
			if (!bo) throw new Error("Bo's turn asked nothing");
			for (const sent of asSent(bo)) {
				for (const secret of SECRETS) expect(sent).not.toContain(secret);
				expect(sent).toContain(HIDDEN);
			}
		} finally {
			await host.stop();
		}
	});
});
