import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import type { RoomMessage } from "../api-types.ts";
import { RoomLog } from "./room-log.ts";
import { Rooms } from "./rooms.ts";
import { AppSurfaceThreads } from "./surface-threads.ts";
import { WebThreads } from "./threads.ts";

const PARENT = "app:agent.guide";

describeDb("the app surface's dispatch threads", () => {
	let sql: SQL;
	let log: RoomLog;
	let threads: WebThreads;
	/** What the surface announced: stored rows, edits of rows, and room-list changes. */
	const events: string[] = [];
	let surface: AppSurfaceThreads;

	beforeAll(async () => {
		// The tables are created if absent and never dropped: the host-migrated ledger would not recreate them.
		sql = new SQL(testDatabaseUrl, { max: 2 });
		await RoomLog.migration.up(sql);
		await WebThreads.migration.up(sql);
		log = new RoomLog(sql);
		threads = new WebThreads(sql);
		surface = new AppSurfaceThreads({
			surface: "app",
			threads,
			publish: (row) => log.append(row),
			edit: async (room: string, id: number, text: string) => {
				const message = await log.edit(id, text);
				events.push(`edited ${room} ${message?.text}`);
			},
			changed: () => void events.push("changed"),
			canHost: async (parent) => parent === PARENT,
		});
	});
	afterAll(async () => {
		await sql.close();
	});

	const textsOf = async (room: string): Promise<RoomMessage[]> =>
		(await log.page(room, undefined, 50)).messages;

	test("open posts the start line in the parent, makes the thread, and edits the line to link it", async () => {
		events.length = 0;
		const opened = await surface.open(PARENT, "Ask the scout", (mention) =>
			mention
				? `🧵 Started: Ask the scout → ${mention}`
				: "🧵 Started: Ask the scout",
		);
		if (!opened) throw new Error("the thread was not opened");
		expect(opened.id).toMatch(/^thread\.[0-9a-f-]{36}$/);
		expect(opened.mention).toBe(`[Ask the scout](app:${opened.id})`);
		const line = (await textsOf(PARENT)).at(-1);
		expect(line).toMatchObject({
			kind: "system",
			text: `🧵 Started: Ask the scout → [Ask the scout](app:${opened.id})`,
		});
		expect(events).toEqual([`edited ${PARENT} ${line?.text}`, "changed"]);
		expect(await threads.get(opened.id)).toMatchObject({
			parent: PARENT,
			title: "Ask the scout",
			open: true,
		});
	});

	test("a title with brackets still makes one link", async () => {
		const opened = await surface.open(
			PARENT,
			"Fix [wip] ] now",
			(mention) => mention ?? "start",
		);
		expect(opened?.mention).toBe(`[Fix (wip) ) now](app:${opened?.id})`);
	});

	test("a parent that cannot host one gets nothing: no line, no thread", async () => {
		const before = (await threads.list()).length;
		const room = "app:thread.00000000-0000-4000-8000-000000000001";
		expect(await surface.open(room, "x", () => "start")).toBeUndefined();
		expect(
			await surface.open("app:agent.nobody", "x", () => "start"),
		).toBeUndefined();
		expect(await textsOf(room)).toEqual([]);
		expect((await threads.list()).length).toBe(before);
	});

	test("posts land in the thread, a notice line is a system line, and a sent post is edited in place", async () => {
		const opened = await surface.open(PARENT, "Work", () => "start");
		if (!opened) throw new Error("the thread was not opened");
		const room = `app:${opened.id}`;
		await surface.post(opened.id, "**progress**");
		await surface.post(opened.id, "-# Restarted before this finished.");
		if (!surface.send) throw new Error("the surface has no send");
		const live = await surface.send(opened.id, "working…");
		events.length = 0;
		await live.edit("done");
		const rows = await textsOf(room);
		expect(rows.map((row) => [row.kind, row.text])).toEqual([
			["agent", "**progress**"],
			["system", "Restarted before this finished."],
			["agent", "done"],
		]);
		expect(events).toEqual([`edited ${room} done`]);
	});

	test("close ends the thread but keeps it a room the page can read", async () => {
		const opened = await surface.open(PARENT, "Short", () => "start");
		if (!opened) throw new Error("the thread was not opened");
		events.length = 0;
		await surface.close(opened.id);
		expect(events).toEqual(["changed"]);
		expect((await threads.get(opened.id))?.open).toBe(false);
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
			log,
			modes: { peek: () => ({ yolo: false, longRunning: false }) },
			activity: () => ({ typing: false, stoppable: false }),
		});
		expect(await rooms.resolve(`app:${opened.id}`)).toMatchObject({
			kind: "thread",
			readOnly: true,
			displayName: "Short",
		});
		const listed = (await rooms.list()).find(
			(room) => room.key === `app:${opened.id}`,
		);
		expect(listed).toMatchObject({
			kind: "thread",
			parent: PARENT,
			readOnly: true,
			closed: true,
		});
	});
});
