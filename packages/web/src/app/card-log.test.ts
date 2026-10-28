import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import type { ClosedCard, PromptFrame } from "../api-types.ts";
import { CardLog } from "./card-log.ts";
import { RoomLog } from "./room-log.ts";

const ROOM = "app:agent.cardlog";
const OTHER = "app:agent.cardlog-other";

const approval = (id: string, at: string): PromptFrame => ({
	id,
	at,
	kind: "approval",
	title: "Send it?",
	message: "Send the note",
	purpose: "action",
});

const closed = (
	id: string,
	at: string,
	over: Partial<ClosedCard> = {},
): ClosedCard => ({
	room: ROOM,
	frame: approval(id, at),
	outcome: "approved",
	by: "Ada",
	closedAt: new Date(Date.parse(at) + 5000).toISOString(),
	...over,
});

describeDb("the cards kept for the app's rooms", () => {
	let sql: SQL;
	let cards: CardLog;
	let log: RoomLog;
	beforeAll(async () => {
		// The tables are created if absent and never dropped: the host-migrated ledger would not recreate them.
		sql = new SQL(testDatabaseUrl, { max: 2 });
		await RoomLog.migration.up(sql);
		await CardLog.migration.up(sql);
		cards = new CardLog(sql);
		log = new RoomLog(sql);
		await sql`DELETE FROM web_room_cards WHERE room IN ${sql([ROOM, OTHER])}`;
		await sql`DELETE FROM web_room_messages WHERE room IN ${sql([ROOM, OTHER])}`;
	});
	afterAll(async () => {
		await sql.close();
	});

	test("the migration can run again over its own table", async () => {
		await CardLog.migration.up(sql);
		await CardLog.migration.up(sql);
		const [row] = await sql`SELECT to_regclass('web_room_cards') AS name`;
		expect(row.name).toBe("web_room_cards");
	});

	test("an ended card comes back with its outcome, who answered, what and when", async () => {
		const answered: ClosedCard = closed("c-ask", "2026-10-28T09:00:00.000Z", {
			frame: {
				id: "c-ask",
				at: "2026-10-28T09:00:00.000Z",
				kind: "ask",
				title: "Which?",
				question: "Which colour?",
				options: [{ label: "red" }, { label: "blue" }],
				multi: false,
				allowOther: true,
			},
			outcome: "answered",
			answer: { kind: "ask", answer: { choices: ["red"], text: "dark" } },
		});
		await cards.record(answered);
		const { by: _nobody, ...expired } = closed(
			"c-exp",
			"2026-10-28T09:01:00.000Z",
			{ outcome: "expired", closedAt: "2026-10-29T09:01:00.000Z" },
		);
		await cards.record(expired);
		const got = await cards.during(ROOM, {});
		expect(got.map((c) => c.frame.id)).toEqual(["c-ask", "c-exp"]);
		expect(got[0]).toEqual(answered);
		// Nobody answered an expired card, so it names no one.
		expect(got[1]).toEqual(expired);
		expect(got[1]).not.toHaveProperty("by");
		expect(await cards.during(OTHER, {})).toEqual([]);
	});

	test("a card recorded twice stays as it was first recorded", async () => {
		await cards.record(closed("c-twice", "2026-10-28T09:02:00.000Z"));
		await cards.record(
			closed("c-twice", "2026-10-28T09:02:00.000Z", {
				outcome: "declined",
				by: "Mel",
			}),
		);
		const got = (await cards.during(ROOM, {})).filter(
			(c) => c.frame.id === "c-twice",
		);
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ outcome: "approved", by: "Ada" });
	});

	test("a read waits for the card that was just recorded", async () => {
		await sql`DELETE FROM web_room_cards WHERE room = ${OTHER}`;
		const written = cards.record(
			closed("c-fresh", "2026-10-28T09:03:00.000Z", { room: OTHER }),
		);
		// Not awaited: the page that reloads on the closing frame reads at once.
		expect((await cards.during(OTHER, {})).map((c) => c.frame.id)).toEqual([
			"c-fresh",
		]);
		await written;
	});

	test("a page of history takes the cards that opened in its span of messages", async () => {
		await sql`DELETE FROM web_room_cards WHERE room = ${ROOM}`;
		const first = await log.append({
			room: ROOM,
			kind: "owner",
			author: "Ada",
			text: "one",
		});
		await Bun.sleep(30);
		const early = new Date().toISOString();
		await Bun.sleep(30);
		const second = await log.append({
			room: ROOM,
			kind: "agent",
			author: "Scout",
			text: "two",
		});
		await Bun.sleep(30);
		const late = new Date().toISOString();
		await Bun.sleep(30);
		const third = await log.append({
			room: ROOM,
			kind: "agent",
			author: "Scout",
			text: "three",
		});
		await cards.record(closed("c-before", "2000-01-01T00:00:00.000Z"));
		await cards.record(closed("c-early", early));
		await cards.record(closed("c-late", late));
		await cards.record(
			closed("c-end", new Date(Date.now() + 1000).toISOString()),
		);
		const ids = async (span: { from?: string; before?: number }) =>
			(await cards.during(ROOM, span)).map((c) => c.frame.id);
		// The latest page, whose first message is the second: cards from it on.
		expect(await ids({ from: second.at })).toEqual(["c-late", "c-end"]);
		// The page before the third message, reaching back to the beginning.
		expect(await ids({ before: third.id })).toEqual([
			"c-before",
			"c-early",
			"c-late",
		]);
		// The page before the second message, beginning at the first.
		expect(await ids({ from: first.at, before: second.id })).toEqual([
			"c-early",
		]);
		// A message the room does not hold bounds nothing in, so no card is taken.
		expect(await ids({ before: 2 ** 40 })).toEqual([]);
	});
});
