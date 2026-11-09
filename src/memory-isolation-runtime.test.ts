import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Speaker } from "./core/identity/speakers.ts";
import {
	ANN,
	asSent,
	BO,
	BO_CORE,
	call,
	dirs,
	HIDDEN,
	isolationHost,
	memoryOf,
	OWNER,
	SECRETS,
	STORE,
	SYSTEM,
} from "./fixtures/memory-isolation.ts";

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("bridge reads actual shared history", () => {
	test("prompt-only private memory refuses another bridge reader before a provider call; memory-none turns stay public", async () => {
		for (const kind of ["study", "quiz"]) {
			const host = await isolationHost(
				STORE(),
				[fauxAssistantMessage("OK."), fauxAssistantMessage("unused")],
				{ provider: "claude-bridge" },
			);
			try {
				expect((await host.run(ANN, "fake:room", { kind })).ok).toBe(true);
				const result = await host.run(BO, "fake:room", { kind });
				expect(result.ok).toBe(kind === "quiz");
				expect(host.pending()).toBe(kind === "quiz" ? 0 : 1);
			} finally {
				await host.stop();
			}
		}
	});
	const owner: Speaker = {
		id: OWNER.id,
		name: OWNER.name,
		tier: "owner",
		principalId: OWNER.id,
	};
	test("owner and SYSTEM run over owner memory; guest is refused without a provider call, including after restart", async () => {
		const store = memoryOf({ owner: [{ fact: "OWNER_SECRET", kind: "note" }] });
		const host = await isolationHost(
			store,
			[
				() => call("memory_search", { query: "OWNER_SECRET" }),
				fauxAssistantMessage("OK."),
				fauxAssistantMessage("OK."),
				fauxAssistantMessage("OK."),
			],
			{ provider: "claude-bridge" },
		);
		try {
			expect((await host.run(owner, "fake:room")).ok).toBe(true);
			expect((await host.run(owner, "fake:room")).ok).toBe(true);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(true);
			expect((await host.run(ANN, "fake:room")).ok).toBe(false);
			expect(host.pending()).toBe(0);
		} finally {
			await host.stop();
		}
		// Pi compaction removes the exchange from the active context, not from bridge's retained history.
		const saved = SessionManager.continueRecent(
			join(host.dir, "work"),
			join(host.dir, "sessions", "fake_room"),
		);
		const kept = saved.appendMessage({
			role: "user",
			content: "Public tail",
			timestamp: 100,
		});
		saved.appendMessage(fauxAssistantMessage("Public answer"));
		saved.appendCompaction("Safe public summary", kept, 100);
		const restarted = await isolationHost(
			store,
			[fauxAssistantMessage("OK.")],
			{ provider: "claude-bridge", dir: host.dir },
		);
		try {
			expect((await restarted.run(ANN, "fake:room")).ok).toBe(false);
			expect(restarted.pending()).toBe(1);
			expect((await restarted.run(owner, "fake:room")).ok).toBe(true);
		} finally {
			await restarted.stop();
		}
	});
	test("only the guest's own memory admits the guest and refuses the owner and SYSTEM", async () => {
		const host = await isolationHost(
			STORE(),
			[
				() => call("memory_search", { query: "doctor" }),
				fauxAssistantMessage("OK."),
				fauxAssistantMessage("OK."),
				fauxAssistantMessage("unused"),
			],
			{ provider: "claude-bridge" },
		);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			expect((await host.run(owner, "fake:room")).ok).toBe(false);
			expect((await host.run(SYSTEM, "fake:room")).ok).toBe(false);
			expect(host.pending()).toBe(1);
		} finally {
			await host.stop();
		}
	});
});

describe("memory in a shared conversation's history", () => {
	test("another speaker's and the host's requests carry none of Ann's memory; Ann's own next turn still does", async () => {
		const seen: TranscriptContext[] = [];
		const look: FauxResponseStep = (context) => {
			seen.push(context);
			return fauxAssistantMessage("OK.");
		};
		const host = await isolationHost(STORE(), [
			// Ann's turn finds her note; her prompt shows her core fact.
			() => call("memory_search", { query: "doctor" }),
			look,
			look,
			look,
			look,
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [ann] = seen.splice(0);
			if (!ann) throw new Error("Ann's turn asked nothing after its search");
			// The search found her note, in her own turn.
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
			// Bo's own memory is his request's.
			for (const sent of asSent(bo)) expect(sent).toContain(BO_CORE);
			for (const sent of asSent(again)) {
				expect(sent).toContain("ANN_NOTE_SECRET");
				expect(sent).toContain("ANN_CORE_SECRET");
				expect(sent).not.toContain(HIDDEN);
				expect(sent).not.toContain(BO_CORE);
			}
		} finally {
			await host.stop();
		}
	});

	test("a memory result records in the session whose memory it holds", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(STORE(), [
			() => call("memory_search", { query: "doctor" }),
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("OK.");
			},
		]);
		try {
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			const [own] = seen;
			if (!own) throw new Error("Ann's turn asked nothing after its search");
			// Within her own turn the result is hers, and says so.
			const result = own.messages.findLast((m) => m.role === "toolResult");
			expect(result?.role === "toolResult" && result.details).toEqual({
				privateTo: "ann",
			});
		} finally {
			await host.stop();
		}
	});
});
