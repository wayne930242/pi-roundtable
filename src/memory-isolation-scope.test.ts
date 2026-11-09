import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChannelKey } from "./core/domain/conversation.ts";
import type { TurnConversation } from "./core/domain/ports.ts";
import type { Speaker } from "./core/identity/speakers.ts";
import {
	ANN,
	asSent,
	BO,
	call,
	DIARY,
	dirs,
	isolationHost,
	looking,
	OWNER,
	privateTo,
	SECRETS,
	STORE,
} from "./fixtures/memory-isolation.ts";

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("a conversation whose scope changes", () => {
	test("Ann's private history reaches neither Bo's private turn nor a shared one in the same channel", async () => {
		const seen: TranscriptContext[] = [];
		const host = await isolationHost(STORE(), [
			() => call("memory_search", { query: "doctor" }),
			...looking(seen, 3),
		]);
		try {
			expect(
				(
					await host.run(ANN, "fake:desk", {
						conversation: privateTo("ann"),
						text: DIARY,
					})
				).ok,
			).toBe(true);
			expect(
				(await host.run(BO, "fake:desk", { conversation: privateTo("bo") })).ok,
			).toBe(true);
			expect(
				(
					await host.run(BO, "fake:desk", {
						conversation: { visibility: "shared" },
					})
				).ok,
			).toBe(true);
			const [, bo, shared] = seen;
			if (!bo || !shared) throw new Error("a turn asked nothing");
			for (const request of [bo, shared])
				for (const sent of asSent(request))
					for (const secret of [...SECRETS, "ANN_DIARY_SECRET"])
						expect(sent).not.toContain(secret);
		} finally {
			await host.stop();
		}
	});

	test("a host started again over the sessions does not replay one person's history for another", async () => {
		const first = await isolationHost(STORE(), looking([], 1));
		const seen: TranscriptContext[] = [];
		try {
			expect(
				(
					await first.run(ANN, "fake:desk", {
						conversation: privateTo("ann"),
						text: DIARY,
					})
				).ok,
			).toBe(true);
		} finally {
			await first.stop();
		}
		const again = await isolationHost(STORE(), looking(seen, 1), {
			dir: first.dir,
		});
		try {
			expect(
				(await again.run(BO, "fake:desk", { conversation: privateTo("bo") }))
					.ok,
			).toBe(true);
			const [bo] = seen;
			if (!bo) throw new Error("Bo's turn asked nothing");
			for (const sent of asSent(bo))
				expect(sent).not.toContain("ANN_DIARY_SECRET");
		} finally {
			await again.stop();
		}
	});

	test("changed tools rebuild the session with its history, and so does starting again in the same scope", async () => {
		const seen: TranscriptContext[] = [];
		const first = await isolationHost(STORE(), looking(seen, 2));
		try {
			const ann = { conversation: privateTo("ann") };
			expect(
				(await first.run(ANN, "fake:desk", { ...ann, text: DIARY })).ok,
			).toBe(true);
			first.bumpTools();
			expect((await first.run(ANN, "fake:desk", ann)).ok).toBe(true);
		} finally {
			await first.stop();
		}
		const again = await isolationHost(STORE(), looking(seen, 1), {
			dir: first.dir,
		});
		try {
			expect(
				(await again.run(ANN, "fake:desk", { conversation: privateTo("ann") }))
					.ok,
			).toBe(true);
		} finally {
			await again.stop();
		}
		const [, rebuilt, restarted] = seen;
		for (const request of [rebuilt, restarted])
			expect(JSON.stringify(request?.messages)).toContain("ANN_DIARY_SECRET");
	});

	test("a history recorded before conversations said their scope carries on, and reading its transcript first fixes no scope", async () => {
		const host = await isolationHost(STORE(), looking([], 0));
		const owner: Speaker = {
			id: OWNER.id,
			name: OWNER.name,
			tier: "owner",
			principalId: OWNER.id,
		};
		// A session as 0.8 left it: messages, and nothing about whom it served.
		const old = SessionManager.continueRecent(
			join(host.dir, "work"),
			join(host.dir, "sessions", "fake_riley"),
		);
		old.appendMessage({
			role: "user",
			content: [{ type: "text", text: "RILEY_OLD_NOTE: water the plants." }],
			timestamp: 1,
		});
		old.appendMessage(fauxAssistantMessage("Noted."));
		await host.stop();
		const seen: TranscriptContext[] = [];
		const again = await isolationHost(STORE(), looking(seen, 1), {
			dir: host.dir,
		});
		try {
			const transcript = await again.runtime.recentTranscript("fake:riley", 5);
			expect(transcript.map((entry) => entry.text)).toContain(
				"RILEY_OLD_NOTE: water the plants.",
			);
			expect(
				(
					await again.run(owner, "fake:riley", {
						conversation: privateTo(OWNER.id),
					})
				).ok,
			).toBe(true);
			expect(JSON.stringify(seen[0]?.messages)).toContain("RILEY_OLD_NOTE");
		} finally {
			await again.stop();
		}
	});
});

describe("a conversation the host records anew while its session is open", () => {
	test("a turn naming no conversation is checked against the host's record at every turn, before the model is asked", async () => {
		const seen: TranscriptContext[] = [];
		const recorded = new Map<ChannelKey, TurnConversation>();
		const host = await isolationHost(STORE(), looking(seen, 2), { recorded });
		try {
			// Bo's turn opens the session of a conversation nothing records yet: shared.
			expect(
				(await host.run(BO, "fake:room", { text: "BO_ROOM_TEXT" })).ok,
			).toBe(true);
			// The host then records it as Ann's private conversation, as CONVERSATIONS.adopt does.
			recorded.set("fake:room", privateTo("ann"));
			const refused = await host.run(BO, "fake:room");
			expect(refused.ok).toBe(false);
			if (!refused.ok)
				expect(refused.error.message).toContain("private to ann");
			expect(seen).toHaveLength(1);
			// Ann's turn runs in a session of her own, without the shared room's history.
			expect((await host.run(ANN, "fake:room")).ok).toBe(true);
			for (const sent of asSent(seen[1] as TranscriptContext))
				expect(sent).not.toContain("BO_ROOM_TEXT");
		} finally {
			await host.stop();
		}
	});
});

describe("a conversation's transcript", () => {
	test("is none while its open session serves someone else than the host now records", async () => {
		const recorded = new Map<ChannelKey, TurnConversation>();
		const host = await isolationHost(STORE(), looking([], 1), { recorded });
		try {
			recorded.set("fake:desk", privateTo("ann"));
			expect((await host.run(ANN, "fake:desk", { text: DIARY })).ok).toBe(true);
			const own = await host.runtime.recentTranscript("fake:desk", 5);
			expect(own.map((entry) => entry.text)).toContain(DIARY);
			// The host records it shared now; the next turn would archive Ann's history.
			recorded.set("fake:desk", { visibility: "shared" });
			expect(await host.runtime.recentTranscript("fake:desk", 5)).toEqual([]);
		} finally {
			await host.stop();
		}
	});
});

describe("a conversation nothing names at a turn", () => {
	test("carries on as its history records whom it serves, after a restart too, refusing anyone else", async () => {
		const first = await isolationHost(STORE(), looking([], 1));
		try {
			expect(
				(
					await first.run(ANN, "fake:desk", {
						conversation: privateTo("ann"),
						text: DIARY,
					})
				).ok,
			).toBe(true);
		} finally {
			await first.stop();
		}
		const seen: TranscriptContext[] = [];
		const again = await isolationHost(STORE(), looking(seen, 1), {
			dir: first.dir,
		});
		try {
			const bo = await again.run(BO, "fake:desk");
			expect(bo.ok).toBe(false);
			if (!bo.ok) expect(bo.error.message).toContain("private to ann");
			expect((await again.run(ANN, "fake:desk")).ok).toBe(true);
			expect(JSON.stringify(seen[0]?.messages)).toContain("ANN_DIARY_SECRET");
		} finally {
			await again.stop();
		}
	});
});
