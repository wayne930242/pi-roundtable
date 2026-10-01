import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ChannelKey } from "pi-roundtable";
import {
	describeDb,
	openTestStore,
	silentLogger,
	type TestStore,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { RemoteSessionStore } from "./remote-session-store.ts";
import {
	REMOTE_SESSION_IDLE_MS,
	RemoteSessionSweeper,
} from "./session-sweeper.ts";

const OLD = "11111111-1111-4111-8111-111111111111";
const OLDER = "22222222-2222-4222-8222-222222222222";
const RECENT = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-20T00:00:00Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 86_400_000).toISOString();

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("RemoteSessionStore.idleSince", () => {
	let store: TestStore<RemoteSessionStore>;

	beforeAll(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`DROP TABLE IF EXISTS remote_agent_sessions`;
		await admin.close();
		store = await openTestStore(RemoteSessionStore);
		const sql = new SQL(testDatabaseUrl);
		await sql`
			INSERT INTO remote_agent_sessions (id, last_used_at) VALUES
				(${OLD}, ${daysAgo(15)}), (${OLDER}, ${daysAgo(30)}), (${RECENT}, ${daysAgo(13)})`;
		await sql.close();
	});

	afterAll(async () => {
		await store.close();
	});

	test("lists sessions last used before the cutoff, longest idle first", async () => {
		expect(
			await store.idleSince(new Date(NOW.getTime() - REMOTE_SESSION_IDLE_MS)),
		).toEqual([OLDER, OLD]);
	});
});

function sweeper(
	idle: string[],
	outcome: (channel: ChannelKey) => Promise<"deleted" | "busy">,
) {
	const cutoffs: Date[] = [];
	const asked: ChannelKey[] = [];
	const sweep = new RemoteSessionSweeper({
		sessions: {
			idleSince: async (cutoff) => {
				cutoffs.push(cutoff);
				return idle;
			},
		},
		deleteConversation: (channel) => {
			asked.push(channel);
			return outcome(channel);
		},
		logger: silentLogger(),
		now: () => NOW,
	});
	return { sweep, cutoffs, asked };
}

describe("RemoteSessionSweeper", () => {
	test("deletes each conversation idle for 14 days through the delete path", async () => {
		const { sweep, cutoffs, asked } = sweeper(
			[OLDER, OLD],
			async () => "deleted",
		);
		await sweep.sweep();
		expect(cutoffs).toEqual([new Date("2026-10-06T00:00:00Z")]);
		expect(asked).toEqual([`mcp:${OLDER}`, `mcp:${OLD}`]);
	});

	test("a busy or failing conversation does not stop the rest", async () => {
		const { sweep, asked } = sweeper([OLDER, OLD, RECENT], async (channel) => {
			if (channel === `mcp:${OLDER}`) return "busy";
			if (channel === `mcp:${OLD}`) throw new Error("disk");
			return "deleted";
		});
		await sweep.sweep();
		expect(asked).toEqual([`mcp:${OLDER}`, `mcp:${OLD}`, `mcp:${RECENT}`]);
	});

	test("a failed lookup is logged, not thrown", async () => {
		const sweep = new RemoteSessionSweeper({
			sessions: {
				idleSince: async () => {
					throw new Error("database down");
				},
			},
			deleteConversation: async () => "deleted",
			logger: silentLogger(),
		});
		await expect(sweep.sweep()).resolves.toBeUndefined();
	});
});
