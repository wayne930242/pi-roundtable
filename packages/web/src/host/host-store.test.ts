import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import { FileDir } from "../app/files.ts";
import { RoomLog } from "../app/room-log.ts";
import { HostCardLog } from "./cards.ts";
import { RoomReads } from "./reads.ts";
import { sweepHostKinds } from "./retention.ts";

const DAY = 86_400_000;
const ROOM = "app:inbox.store0001";
const OTHER = "app:inbox.store0002";
const ELSEWHERE = "app:agent.storeagent";

describeDb("what the host rooms store", () => {
	let sql: SQL;
	let log: RoomLog;
	let cards: HostCardLog;
	let reads: RoomReads;
	beforeAll(async () => {
		// The tables are created if absent and never dropped: the host-migrated ledger would not recreate them.
		sql = new SQL(testDatabaseUrl, { max: 2 });
		await RoomLog.migration.up(sql);
		await RoomLog.hostMigration.up(sql);
		await RoomLog.noteMigration.up(sql);
		await HostCardLog.migration.up(sql);
		await HostCardLog.keepMigration.up(sql);
		await RoomReads.migration.up(sql);
		log = new RoomLog(sql);
		cards = new HostCardLog(sql);
		reads = new RoomReads(sql);
		const rooms = sql([ROOM, OTHER, ELSEWHERE]);
		await sql`DELETE FROM web_room_messages WHERE room IN ${rooms}`;
		await sql`DELETE FROM web_host_cards WHERE room IN ${rooms}`;
		await sql`DELETE FROM web_room_reads WHERE room IN ${rooms}`;
	});
	afterAll(async () => {
		await sql.close();
	});

	test("the migrations can run again over their own tables", async () => {
		for (const migration of [
			RoomLog.hostMigration,
			HostCardLog.migration,
			HostCardLog.keepMigration,
			RoomReads.migration,
		]) {
			await migration.up(sql);
			await migration.up(sql);
		}
		const [row] = await sql`SELECT to_regclass('web_room_reads') AS name`;
		expect(row.name).toBe("web_room_reads");
	});

	test("a message keeps who wrote it, the host's reference and its own time", async () => {
		const at = new Date("2026-10-01T08:00:00.000Z");
		const { message, created } = await log.appendOnce({
			room: ROOM,
			kind: "owner",
			author: "Pat Customer",
			text: "My order is late",
			authorKind: "external",
			authorLabel: "Customer",
			picture: { initials: "PC", color: "#336699" },
			reference: "<mail-1@example.test>",
			at,
		});
		expect(created).toBe(true);
		expect(message).toMatchObject({
			room: ROOM,
			author: "Pat Customer",
			authorKind: "external",
			authorLabel: "Customer",
			picture: { initials: "PC", color: "#336699" },
			at: at.toISOString(),
		});
		expect(message.edited).toBeUndefined();
	});

	test("a second post with the same reference stores nothing and answers the first", async () => {
		const first = await log.appendOnce({
			room: ROOM,
			kind: "owner",
			author: "Pat",
			text: "one",
			authorKind: "external",
			reference: "<same@example.test>",
		});
		const again = await log.appendOnce({
			room: ROOM,
			kind: "owner",
			author: "Pat",
			text: "one, again",
			authorKind: "external",
			reference: "<same@example.test>",
		});
		expect(again.created).toBe(false);
		expect(again.message.id).toBe(first.message.id);
		expect(again.message.text).toBe("one");
		expect(await log.byReference(ROOM, "<same@example.test>")).toBe(
			first.message.id,
		);
		// The same reference in another room is another message.
		const other = await log.appendOnce({
			room: OTHER,
			kind: "owner",
			author: "Pat",
			text: "elsewhere",
			authorKind: "external",
			reference: "<same@example.test>",
		});
		expect(other.created).toBe(true);
		expect(
			await log.byReference(ROOM, "<nobody@example.test>"),
		).toBeUndefined();
	});

	test("an edit marks the message edited only when the host asks, and a removal returns what was deleted", async () => {
		const { message } = await log.appendOnce({
			room: ROOM,
			kind: "owner",
			author: "Pat",
			text: "typo",
			authorKind: "external",
		});
		expect(
			(await log.edit(ROOM, message.id, "quiet fix"))?.edited,
		).toBeUndefined();
		const marked = await log.edit(ROOM, message.id, "fixed", true);
		expect(marked).toMatchObject({ text: "fixed", edited: true });
		expect(await log.edit(OTHER, message.id, "not here", true)).toBeUndefined();
		const removed = await log.remove(ROOM, message.id);
		expect(removed?.text).toBe("fixed");
		expect(await log.remove(ROOM, message.id)).toBeUndefined();
		expect(await log.get(ROOM, message.id)).toBeUndefined();
	});

	test("a card is stored, replaced in place and listed oldest first", async () => {
		const made = await cards.create(ROOM, {
			title: "Suggested reply",
			body: "Ask for the order number",
			tone: "note",
			state: "open",
			buttons: [{ id: "send", label: "Send" }],
		});
		const second = await cards.create(ROOM, { title: "Second", body: "b" });
		const updated = await cards.update(ROOM, made.id, {
			title: "Suggested reply",
			body: "Sent",
			state: "done",
		});
		expect(updated).toMatchObject({ id: made.id, state: "done", body: "Sent" });
		expect(updated?.buttons).toBeUndefined();
		expect((await cards.list(ROOM)).map((card) => card.id)).toEqual([
			made.id,
			second.id,
		]);
		// A card of another room is not reachable through this one.
		expect(
			await cards.update(OTHER, made.id, { title: "x", body: "y" }),
		).toBeUndefined();
		expect(await cards.get(OTHER, made.id)).toBeUndefined();
	});

	test("a cursor moves forward only, and no further than the newest message", async () => {
		const ids: number[] = [];
		for (const text of ["a", "b", "c"])
			ids.push(
				(
					await log.appendOnce({
						room: OTHER,
						kind: "owner",
						author: "Pat",
						text,
						authorKind: "external",
					})
				).message.id,
			);
		const [first, second, third] = ids as [number, number, number];
		expect((await reads.advance(OTHER, "ada", second))?.upTo).toBe(second);
		// Behind the cursor: nothing moves, and nothing is reported.
		expect(await reads.advance(OTHER, "ada", first)).toBeUndefined();
		expect(await reads.cursorOf(OTHER, "ada")).toBe(second);
		// Beyond the newest message: clamped to it.
		expect((await reads.advance(OTHER, "ada", third + 1000))?.upTo).toBe(third);
		expect(await reads.advance(OTHER, "ada", third)).toBeUndefined();
		// A room with no messages has nothing to read.
		expect(
			await reads.advance("app:inbox.emptyroom1", "ada", 5),
		).toBeUndefined();
		expect(await reads.cursorOf(OTHER, "mel")).toBeUndefined();
	});

	test("unread counts the messages past the cursor, not the server's own lines, and a room never read is all unread", async () => {
		await sql`DELETE FROM web_room_messages WHERE room = ${ROOM}`;
		await sql`DELETE FROM web_room_reads WHERE room = ${ROOM}`;
		const ids: number[] = [];
		for (const [kind, text] of [
			["owner", "one"],
			["system", "a divider"],
			["agent", "two"],
			["owner", "three"],
		] as const)
			ids.push(
				(await log.appendOnce({ room: ROOM, kind, author: "x", text })).message
					.id,
			);
		expect((await reads.unread("mel", [ROOM])).get(ROOM)).toBe(3);
		await reads.advance(ROOM, "mel", ids[2] as number);
		expect((await reads.unread("mel", [ROOM])).get(ROOM)).toBe(1);
		await reads.advance(ROOM, "mel", ids[3] as number);
		expect((await reads.unread("mel", [ROOM])).has(ROOM)).toBe(false);
		// Another person's cursor is their own.
		expect((await reads.unread("zed", [ROOM])).get(ROOM)).toBe(3);
	});

	test("a baseline room starts at what it holds, so its history is not unread but what comes after is", async () => {
		await log.appendOnce({
			room: ELSEWHERE,
			kind: "agent",
			author: "A",
			text: "old",
		});
		const baseline = new Set([ELSEWHERE]);
		expect(
			(await reads.unread("ada", [ELSEWHERE], baseline)).has(ELSEWHERE),
		).toBe(false);
		await log.appendOnce({
			room: ELSEWHERE,
			kind: "agent",
			author: "A",
			text: "new",
		});
		expect(
			(await reads.unread("ada", [ELSEWHERE], baseline)).get(ELSEWHERE),
		).toBe(1);
	});

	test("a baseline room with nothing in it yet starts at the beginning, so the first thing said there is unread", async () => {
		// The database is shared between runs: this room and this person are new to it.
		const run = Math.random().toString(36).slice(2, 8);
		const fresh = `${ELSEWHERE}-empty-${run}` as typeof ELSEWHERE;
		const person = `reader-${run}`;
		const baseline = new Set([fresh]);
		expect((await reads.unread(person, [fresh], baseline)).has(fresh)).toBe(
			false,
		);
		await log.appendOnce({
			room: fresh,
			kind: "agent",
			author: "A",
			text: "first",
		});
		// A second look at the room does not move the cursor on to the newest message.
		expect((await reads.unread(person, [fresh], baseline)).get(fresh)).toBe(1);
	});

	test("reading many rooms moves each cursor to the room's newest message, reports where it was, and leaves read rooms and other people alone", async () => {
		const run = Math.random().toString(36).slice(2, 8);
		const person = `bulk-${run}`;
		const [fresh, behind, caught, empty] = [
			"fresh",
			"behind",
			"caught",
			"empty",
		].map((name) => `app:inbox.${name}${run}`);
		const idsOf: Record<string, number[]> = {};
		for (const room of [fresh, behind, caught] as string[]) {
			idsOf[room] = [];
			for (const text of ["a", "b", "c"])
				idsOf[room]?.push(
					(
						await log.appendOnce({
							room,
							kind: "agent",
							author: "A",
							text,
						})
					).message.id,
				);
		}
		await reads.advance(
			behind as string,
			person,
			idsOf[behind as string]?.[0] as number,
		);
		await reads.advance(
			caught as string,
			person,
			idsOf[caught as string]?.[2] as number,
		);
		await reads.advance(
			fresh as string,
			"someone-else",
			idsOf[fresh as string]?.[2] as number,
		);
		const moved = await reads.advanceAll(person, [
			fresh as string,
			behind as string,
			caught as string,
			empty as string,
		]);
		const byRoom = new Map(moved.map((one) => [one.room, one]));
		expect([...byRoom.keys()].sort()).toEqual(
			[fresh, behind].sort() as string[],
		);
		expect(byRoom.get(fresh as string)).toMatchObject({
			from: 0,
			to: idsOf[fresh as string]?.[2],
		});
		expect(byRoom.get(behind as string)).toMatchObject({
			from: idsOf[behind as string]?.[0],
			to: idsOf[behind as string]?.[2],
		});
		const unread = await reads.unread(person, [
			fresh as string,
			behind as string,
			caught as string,
		]);
		expect(unread.size).toBe(0);
		// A second call finds nothing to move, and an empty list asks nothing.
		expect(await reads.advanceAll(person, [fresh as string])).toEqual([]);
		expect(await reads.advanceAll(person, [])).toEqual([]);
		// Another person's cursor is their own.
		expect(await reads.cursorOf(fresh as string, "someone-else")).toBe(
			idsOf[fresh as string]?.[2],
		);
	});

	test("rewinding puts a cursor back where the bulk read found it, unless the person read on since", async () => {
		const run = Math.random().toString(36).slice(2, 8);
		const person = `rewind-${run}`;
		const [one, two] = [`app:inbox.rewa${run}`, `app:inbox.rewb${run}`];
		for (const room of [one, two] as string[])
			for (const text of ["a", "b"])
				await log.appendOnce({ room, kind: "agent", author: "A", text });
		const moved = await reads.advanceAll(person, [one, two] as string[]);
		expect(moved).toHaveLength(2);
		// Both were never read, so they go back to nothing read: every message unread again.
		// A third message arrives in `two` and the person reads it before the undo.
		const later = (
			await log.appendOnce({
				room: two as string,
				kind: "agent",
				author: "A",
				text: "c",
			})
		).message.id;
		await reads.advance(two as string, person, later);
		const restored = await reads.rewind(person, moved);
		expect(restored).toEqual([one]);
		expect(
			(await reads.unread(person, [one, two] as string[])).get(one as string),
		).toBe(2);
		expect(
			(await reads.unread(person, [one, two] as string[])).has(two as string),
		).toBe(false);
		// Putting back twice changes nothing more.
		expect(await reads.rewind(person, moved)).toEqual([]);
		expect(await reads.rewind(person, [])).toEqual([]);
		// A "put back" that would move a cursor forward, past where it is, moves nothing.
		const at = await reads.cursorOf(two as string, person);
		expect(
			await reads.rewind(person, [
				{ room: two as string, from: (at ?? 0) + 1000, to: at ?? 0 },
			]),
		).toEqual([]);
		expect(await reads.cursorOf(two as string, person)).toBe(at);
	});

	test("the reads of a room are everyone's cursors", async () => {
		const marks = await reads.marks(OTHER);
		expect(marks.map((mark) => mark.principalId)).toContain("ada");
		expect(marks.every((mark) => mark.upTo > 0)).toBe(true);
	});

	test("retention counts from the message's own time: an import dated past it goes at once, one inside it stays, and the files and cards go with them", async () => {
		const dir = new FileDir(mkdtempSync(join(tmpdir(), "host-retention-")));
		const kept = dir.put(
			"old.txt",
			"text/plain",
			new Uint8Array([1]),
			undefined,
			{
				room: ROOM,
			},
		);
		const now = Date.now();
		await sql`DELETE FROM web_room_messages WHERE room = ${ROOM}`;
		await sql`DELETE FROM web_host_cards WHERE room IN ${sql([ROOM, ELSEWHERE])}`;
		const stale = await log.appendOnce({
			room: ROOM,
			kind: "owner",
			author: "Pat",
			text: "imported, two days old",
			authorKind: "external",
			files: [kept],
			at: new Date(now - 2 * DAY),
		});
		const fresh = await log.appendOnce({
			room: ROOM,
			kind: "owner",
			author: "Pat",
			text: "imported, a few hours old",
			authorKind: "external",
			at: new Date(now - 3_600_000),
		});
		// An agent room's message of the same age is not a host kind's to sweep.
		const agent = await log.appendOnce({
			room: ELSEWHERE,
			kind: "agent",
			author: "A",
			text: "kept",
			at: new Date(now - 30 * DAY),
		});
		await sql`UPDATE web_host_cards SET created_at = now() - interval '3 days' WHERE room = ${ROOM}`;
		const oldCard = await cards.create(ROOM, { title: "old", body: "b" });
		await sql`UPDATE web_host_cards SET created_at = now() - interval '3 days' WHERE id = ${oldCard.id}`;
		// A card the host keeps survives its age; one it stops keeping goes with the next sweep.
		const heldCard = await cards.create(ROOM, {
			title: "open ticket",
			body: "b",
			keep: true,
		});
		const releasedCard = await cards.create(ROOM, {
			title: "closed ticket",
			body: "b",
			keep: true,
		});
		await sql`UPDATE web_host_cards SET created_at = now() - interval '3 days' WHERE id IN ${sql([heldCard.id, releasedCard.id])}`;
		await cards.update(ROOM, releasedCard.id, {
			title: "closed ticket",
			body: "b",
		});
		const newCard = await cards.create(ROOM, { title: "new", body: "b" });
		const swept = await sweepHostKinds({
			registry: {
				kinds: () => [
					{
						kind: "inbox",
						label: "Inbox",
						list: async () => undefined,
						access: async () => undefined,
						retention: { textDays: 1, fileDays: 1 },
					},
				],
			} as never,
			surface: "app",
			log,
			cards,
			reads,
			files: dir,
			now: () => now,
		});
		expect(swept).toMatchObject({ messages: 1, cards: 2, files: 1 });
		expect(await log.get(ROOM, stale.message.id)).toBeUndefined();
		expect(await log.get(ROOM, fresh.message.id)).toBeDefined();
		expect(await log.get(ELSEWHERE, agent.message.id)).toBeDefined();
		expect(dir.has(kept.id)).toBe(false);
		expect((await cards.list(ROOM)).map((card) => card.id)).toEqual([
			heldCard.id,
			newCard.id,
		]);
	});

	test("a kind without retention is kept whole", async () => {
		const before = (await log.page(ROOM, undefined, 100)).messages.length;
		const swept = await sweepHostKinds({
			registry: {
				kinds: () => [
					{
						kind: "inbox",
						label: "Inbox",
						list: async () => undefined,
						access: async () => undefined,
					},
				],
			} as never,
			surface: "app",
			log,
			cards,
			reads,
			files: new FileDir(mkdtempSync(join(tmpdir(), "host-keep-"))),
			now: () => Date.now() + 3650 * DAY,
		});
		expect(swept).toEqual({ messages: 0, cards: 0, files: 0 });
		expect((await log.page(ROOM, undefined, 100)).messages.length).toBe(before);
	});
});
