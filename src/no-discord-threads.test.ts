import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "./core/contract/runtime.ts";
import type { ChatSurface } from "./core/contract/surface.ts";
import { messages } from "./core/i18n/index.ts";
import type { RoundtablePlugin } from "./core/plugin.ts";
import { THREADS } from "./core/services.ts";
import { describeDb } from "./core/testing/database.ts";
import { FakeSurfaceThreads } from "./core/testing/surface-threads.ts";
import { type TestHost, testHost } from "./core/testing/test-host.ts";

const hosts: TestHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
});

const quiet: AgentRuntime = {
	runTurn: async () => ({ ok: true, text: "" }),
	steer: async () => false,
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
};

const guide = {
	name: "guide",
	displayName: "Guide",
	prompt: "You guide the owner.",
	avatarPrompt: "A friendly guide",
};

/** A surface `app` that hosts agent rooms and, through `threads`, dispatch threads. */
function appSurface(threads: FakeSurfaceThreads): RoundtablePlugin {
	const surface: ChatSurface = {
		surface: "app",
		agentRooms: true,
		start: async () => undefined,
		sendReply: async () => undefined,
		threads,
	};
	return { name: "app", setup: () => ({ surfaces: [surface] }) };
}

const until = async (done: () => boolean, what: string) => {
	const deadline = Date.now() + 10_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
};

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("dispatch threads on a host without Discord", () => {
	test("THREADS opens a thread on the room's surface, and the next start closes what a stop left open", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "roundtable-no-discord-"));
		const threads = new FakeSurfaceThreads();
		const boot = async () => {
			const host = await testHost({
				discord: false,
				runtime: quiet,
				config: { agents: [guide], dataDir },
				plugins: [appSurface(threads)],
			});
			hosts.push(host);
			return host;
		};
		const first = await boot();
		const opened = await first.context.services
			.get(THREADS)
			.open("app:agent.guide", "research", "📋 Task: find it");
		expect(opened?.channel).toBe("app:thread.1");
		expect(threads.lines.get("app:agent.guide")).toBe(
			messages().threadStarted("research", "research"),
		);
		expect(threads.textsIn("thread.1")).toEqual(["📋 Task: find it"]);
		// The host stops with the dispatch unfinished: only the ledger remembers its thread.
		await first.stop();
		hosts.splice(hosts.indexOf(first), 1);
		expect(threads.closed).toEqual([]);

		await boot();
		await until(() => threads.closed.length > 0, "the sweep");
		expect(threads.closed).toEqual(["thread.1"]);
		expect(threads.textsIn("thread.1")).toEqual([
			"📋 Task: find it",
			messages().restartNotice,
		]);
	});
});
