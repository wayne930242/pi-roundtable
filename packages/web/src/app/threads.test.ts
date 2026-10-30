import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { channelKey } from "pi-roundtable";
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
		await WebThreads.dismissedMigration.up(sql);
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

	test("a finished thread is dismissed off the list and stays readable; an open one is refused", async () => {
		const thread = await threads.open("app:agent.dismiss", "Done job");
		expect(await threads.dismiss(thread.id)).toBe("open");
		expect((await threads.list()).map((t) => t.id)).toContain(thread.id);
		await threads.close(thread.id);
		expect(await threads.dismiss(thread.id)).toBe("dismissed");
		// Asking again changes nothing.
		expect(await threads.dismiss(thread.id)).toBe("dismissed");
		expect(await threads.dismiss("thread.nobody")).toBe("missing");
		expect((await threads.list()).map((t) => t.id)).not.toContain(thread.id);
		// Dismissed is not deleted: the thread is still stored, closed, and resolves as a room.
		expect(await threads.get(thread.id)).toMatchObject({ open: false });
		expect((await threads.under("app:agent.dismiss")).map((t) => t.id)).toEqual(
			[thread.id],
		);
		await threads.removeUnder("app:agent.dismiss");
	});

	test("a dismissed thread does not take up one of the listed closed slots", async () => {
		const older = await threads.open("app:agent.slots", "Older");
		const newer = await threads.open("app:agent.slots", "Newer");
		await threads.close(older.id);
		await threads.close(newer.id);
		await threads.dismiss(newer.id);
		// One slot: it goes to the older thread, since the newer one was dismissed.
		const listed = (await threads.list(1)).filter((t) =>
			[older.id, newer.id].includes(t.id),
		);
		expect(listed.map((t) => t.id)).toEqual([older.id]);
		await threads.removeUnder("app:agent.slots");
	});

	test("dismissing the finished threads of a room leaves its open ones and other rooms' alone", async () => {
		const open = await threads.open("app:agent.sweep", "Running");
		const done = await threads.open("app:agent.sweep", "Done");
		const already = await threads.open("app:agent.sweep", "Already");
		const other = await threads.open("app:agent.sweep-too", "Other done");
		await threads.close(done.id);
		await threads.close(already.id);
		await threads.close(other.id);
		await threads.dismiss(already.id);
		expect(await threads.dismissFinished("app:agent.sweep")).toBe(1);
		expect(await threads.dismissFinished("app:agent.sweep")).toBe(0);
		const listed = (await threads.list()).map((t) => t.id);
		expect(listed).toContain(open.id);
		expect(listed).not.toContain(done.id);
		expect(listed).toContain(other.id);
		await threads.removeUnder("app:agent.sweep");
		await threads.removeUnder("app:agent.sweep-too");
	});

	test("a dismissed thread is off the room list and still a room with a view of its own", async () => {
		const thread = await threads.open("app:agent.guide", "Gone from view");
		await threads.close(thread.id);
		await threads.dismiss(thread.id);
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
		const key = channelKey("app", thread.id);
		expect((await rooms.list()).map((r) => r.key)).not.toContain(key);
		expect(await rooms.resolve(key)).toMatchObject({ kind: "thread" });
		expect(await rooms.threadView(key)).toMatchObject({
			key,
			kind: "thread",
			displayName: "Gone from view",
			parent: "app:agent.guide",
			readOnly: true,
			closed: true,
		});
		// Only a thread has this view; an agent's room is on the list.
		expect(await rooms.threadView("app:agent.guide")).toBeUndefined();
		await threads.removeUnder("app:agent.guide");
	});
});
