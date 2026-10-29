import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import { Rooms } from "./rooms.ts";
import { WebThreads } from "./threads.ts";

describeDb("dispatch threads of the app", () => {
	let sql: SQL;
	let threads: WebThreads;
	beforeAll(async () => {
		// The table is created if absent and never dropped: the host-migrated ledger would not recreate it.
		sql = new SQL(testDatabaseUrl, { max: 2 });
		await WebThreads.migration.up(sql);
		threads = new WebThreads(sql);
	});
	afterAll(async () => {
		await sql.close();
	});

	test("a thread is opened under a room, listed while open, and closed", async () => {
		const thread = await threads.open("app:agent.guide", "  Ask the scout  ");
		expect(thread.id).toMatch(/^thread\.[0-9a-f-]{36}$/);
		expect(thread).toMatchObject({
			parent: "app:agent.guide",
			title: "Ask the scout",
			open: true,
		});
		expect((await threads.list()).map((t) => t.id)).toContain(thread.id);
		await threads.close(thread.id);
		expect((await threads.get(thread.id))?.open).toBe(false);
		// A closed thread is still listed, among the latest closed ones only.
		expect((await threads.list()).find((t) => t.id === thread.id)?.open).toBe(
			false,
		);
		expect((await threads.list(0)).map((t) => t.id)).not.toContain(thread.id);
	});

	test("the threads under a room are listed and removed with it, and no other room's", async () => {
		const mine = await threads.open("app:agent.gone", "One");
		const closed = await threads.open("app:agent.gone", "Two");
		await threads.close(closed.id);
		const other = await threads.open("app:agent.gone-too", "Other");
		expect((await threads.under("app:agent.gone")).map((t) => t.id)).toEqual([
			mine.id,
			closed.id,
		]);
		expect(await threads.removeUnder("app:agent.gone")).toBe(2);
		expect(await threads.under("app:agent.gone")).toEqual([]);
		expect(await threads.get(other.id)).toBeDefined();
		expect(await threads.removeUnder("app:agent.gone")).toBe(0);
		await threads.removeUnder("app:agent.gone-too");
	});

	test("a thread is a read-only room of the app and nothing else's, open or closed", async () => {
		const thread = await threads.open("app:agent.guide", "Look");
		const rooms = new Rooms({
			surface: "app",
			mount: "/console",
			directory: {
				agents: () => [],
				agent: () => undefined,
				groups: () => [],
				group: () => undefined,
			},
			team: { coordinator: () => undefined },
			avatars: { url: () => "/avatars/x.png" },
			threads,
			log: { lastOf: async () => new Map() },
			modes: { peek: () => ({ yolo: false, longRunning: false }) },
			mutes: { all: async () => new Set() },
			activity: () => ({ typing: false, stoppable: false }),
		});
		expect(await rooms.resolve(`app:${thread.id}`)).toMatchObject({
			kind: "thread",
			readOnly: true,
			displayName: "Look",
		});
		expect(await rooms.resolve(`other:${thread.id}`)).toBeUndefined();
		expect(await rooms.resolve("app:thread.not-a-uuid")).toBeUndefined();
		await threads.close(thread.id);
		expect(await rooms.resolve(`app:${thread.id}`)).toMatchObject({
			kind: "thread",
			readOnly: true,
		});
		expect(
			(await rooms.list()).find((r) => r.key === `app:${thread.id}`),
		).toMatchObject({
			parent: "app:agent.guide",
			closed: true,
		});
	});
});
