import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ChannelKey } from "pi-roundtable";
import {
	describeDb,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import type { ClientFrame, RoomMessage } from "../api-types.ts";
import { BlockAnswering, type BlockOutcome } from "./block-answering.ts";
import type { Answerer } from "./desk.ts";
import { RoomLog } from "./room-log.ts";

const ROOM = "app:agent.blocks-answering" as ChannelKey;
const OWNER = {
	principalId: "p-ada",
	name: "Ada",
	tier: "owner",
	actor: { provider: "token", subject: "web", name: "Web" },
} as unknown as Answerer;

const OPTIONS = [
	"```options",
	"- title: SQLite",
	"- title: Postgres",
	"```",
].join("\n");
const FORM = [
	"```form",
	"title: Stores",
	"questions:",
	"  - name: store",
	"    type: single",
	"    required: true",
	"    choices: [{value: sqlite, label: SQLite}, {value: pg, label: Postgres}]",
	"  - name: extras",
	"    type: multi",
	"    choices: [{value: cache, label: Cache}, {value: queue, label: Queue}]",
	"```",
].join("\n");
const SUGGEST = ["```suggest", "- /compact", "- Ship it", "```"].join("\n");

type Frame = Extract<ClientFrame, { type: "block_answer" }>;
const frame = (
	message: number,
	block: number,
	answer: Frame["answer"],
): Frame => ({
	type: "block_answer",
	id: "b1",
	room: ROOM,
	message,
	block,
	answer,
});
const pick = (title: string): Frame["answer"] => ({
	kind: "pick",
	fields: [["picked", title]],
});

describeDb("the owner's answer to an interactive block", () => {
	let sql: SQL;
	let log: RoomLog;
	let started = true;
	let readOnly = false;
	let sendError: Error | undefined;
	let sent: { room: string; text: string }[] = [];
	let shown: RoomMessage[] = [];
	let nextAnswerId = 1000;
	let answering: BlockAnswering;

	/** An agent reply holding the given markdown. */
	const reply = (text: string) =>
		log.append({
			room: ROOM,
			kind: "agent",
			agent: "guide",
			author: "Guide",
			text,
		});
	const answer = (f: Frame, who: Answerer = OWNER): Promise<BlockOutcome> =>
		answering.answer(f, who, async (room, text, stored) => {
			if (sendError) throw sendError;
			sent.push({ room, text });
			await stored({ id: nextAnswerId++ } as RoomMessage);
		});

	beforeAll(async () => {
		sql = new SQL(testDatabaseUrl, { max: 4 });
		for (const m of [
			RoomLog.migration,
			RoomLog.hostMigration,
			RoomLog.noteMigration,
			RoomLog.intercomMigration,
			RoomLog.startOverMigration,
			RoomLog.deliveryMigration,
			RoomLog.blockAnswersMigration,
			RoomLog.blockAnswersMessageIndexMigration,
		])
			await m.up(sql);
		log = new RoomLog(sql);
		answering = new BlockAnswering({
			rooms: {
				resolve: async (key) =>
					key === ROOM
						? ({
								key: ROOM,
								kind: "agent",
								name: "guide",
								displayName: "Guide",
								readOnly,
							} as never)
						: undefined,
			},
			log,
			surface: {
				get started() {
					return started;
				},
				showChange: (message: RoomMessage) => {
					shown.push(message);
				},
			},
			logger: silentLogger(),
		});
	});
	beforeEach(async () => {
		started = true;
		readOnly = false;
		sendError = undefined;
		sent = [];
		shown = [];
		await sql`DELETE FROM web_room_messages WHERE room = ${ROOM}`;
	});
	afterAll(async () => {
		await sql`DELETE FROM web_room_messages WHERE room = ${ROOM}`;
		await sql.close();
	});

	test("a pick is sent as the owner's message with the text the agent reads, and locks the block", async () => {
		const message = await reply(`Which?\n\n${OPTIONS}`);
		const outcome = await answer(frame(message.id, 0, pick("SQLite")));
		if (!outcome.ok) throw new Error("not answered");
		const answerId = outcome.message.id;
		expect(sent).toEqual([{ room: ROOM, text: 'User picked "SQLite".' }]);
		const stored = await log.get(ROOM, message.id);
		expect(stored?.answers).toEqual([
			{ block: 0, fields: [["picked", "SQLite"]] },
		]);
		// The change is shown to every socket with the lock on it.
		expect(shown.at(-1)?.answers).toEqual(stored?.answers);
		// The answer message is linked, so cancelling it can reopen the block.
		const [row] =
			await sql`SELECT answer_message_id FROM web_room_block_answers WHERE message_id = ${message.id}`;
		expect(Number(row?.answer_message_id)).toBe(answerId);
		// History carries the lock too.
		const page = await log.page(ROOM, undefined, 10);
		expect(page.messages.find((one) => one.id === message.id)?.answers).toEqual(
			stored?.answers,
		);
	});

	test("the answer is linked to its message in the same step the message is stored, before the host gets it", async () => {
		const message = await reply(OPTIONS);
		let linked: unknown;
		const outcome = await answering.answer(
			frame(message.id, 0, pick("SQLite")),
			OWNER,
			async (_room, _text, stored) => {
				await stored({ id: 4242 } as RoomMessage);
				// Here the host would get the message and may queue it: a cancel must find the row.
				[linked] =
					await sql`SELECT answer_message_id FROM web_room_block_answers WHERE message_id = ${message.id}`;
			},
		);
		expect(outcome.ok).toBe(true);
		expect(
			Number((linked as { answer_message_id: unknown }).answer_message_id),
		).toBe(4242);
	});

	test("a message's answers are found by message id without a scan of the table", async () => {
		const rows =
			await sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'web_room_block_answers'`;
		expect(
			rows.some((row: { indexdef: string }) =>
				/\(message_id\)/.test(row.indexdef),
			),
		).toBe(true);
	});

	test("a second answer to the same block is refused with the first one's fields, and sends nothing", async () => {
		const message = await reply(OPTIONS);
		await answer(frame(message.id, 0, pick("SQLite")));
		const again = await answer(frame(message.id, 0, pick("Postgres")));
		expect(again).toEqual({
			ok: false,
			code: "answered",
			fields: [["picked", "SQLite"]],
		});
		expect(sent).toHaveLength(1);
	});

	test("two taps at once send once", async () => {
		const message = await reply(OPTIONS);
		const results = await Promise.all([
			answer(frame(message.id, 0, pick("SQLite"))),
			answer(frame(message.id, 0, pick("SQLite"))),
		]);
		expect(results.filter((one) => one.ok)).toHaveLength(1);
		expect(
			results.filter((one) => !one.ok && one.code === "answered"),
		).toHaveLength(1);
		expect(sent).toHaveLength(1);
	});

	test("each block of a message is answered on its own", async () => {
		const message = await reply(`${OPTIONS}\n\n${SUGGEST}`);
		expect((await answer(frame(message.id, 0, pick("SQLite")))).ok).toBe(true);
		expect(
			(
				await answer(
					frame(message.id, 1, {
						kind: "suggest",
						fields: [["text", "Ship it"]],
					}),
				)
			).ok,
		).toBe(true);
		const stored = await log.get(ROOM, message.id);
		expect(stored?.answers?.map((one) => one.block)).toEqual([0, 1]);
		expect(sent.map((one) => one.text)).toEqual([
			'User picked "SQLite".',
			"Ship it",
		]);
	});

	test("a form with several values for a multi question sends every one; several for a single question are refused", async () => {
		const message = await reply(FORM);
		const bad = await answer(
			frame(message.id, 0, {
				kind: "form",
				fields: [
					["store", "sqlite"],
					["store", "pg"],
				],
			}),
		);
		expect(bad).toMatchObject({ ok: false, code: "invalid" });
		expect(sent).toEqual([]);
		const good = await answer(
			frame(message.id, 0, {
				kind: "form",
				fields: [
					["store", "sqlite"],
					["extras", "cache"],
					["extras", "queue"],
				],
			}),
		);
		expect(good.ok).toBe(true);
		expect(sent[0]?.text).toContain("- extras: cache");
		expect(sent[0]?.text).toContain("- extras: queue");
		expect(sent[0]?.text).toContain("- store: sqlite");
	});

	test("a required question left unanswered is refused at that question", async () => {
		const message = await reply(FORM);
		const outcome = await answer(
			frame(message.id, 0, { kind: "form", fields: [["extras", "cache"]] }),
		);
		expect(outcome).toMatchObject({ ok: false, code: "invalid" });
		expect(outcome.ok === false && outcome.reason).toContain("store");
		expect(sent).toEqual([]);
		// A refused answer takes nothing: the block is open still.
		expect((await log.get(ROOM, message.id))?.answers).toBeUndefined();
	});

	test("the page's claims are not taken on trust: wrong index, wrong kind, unknown name, too many fields", async () => {
		const message = await reply(OPTIONS);
		expect(await answer(frame(message.id, 3, pick("SQLite")))).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(
			await answer(frame(message.id, 0, { kind: "form", fields: [] })),
		).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(await answer(frame(message.id, 0, pick("Mongo")))).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(
			await answer(
				frame(message.id, 0, {
					kind: "pick",
					fields: Array.from(
						{ length: 65 },
						() => ["picked", "SQLite"] as [string, string],
					),
				}),
			),
		).toMatchObject({ ok: false, code: "invalid" });
		expect(sent).toEqual([]);
	});

	test("the title in the text is the block's own, whatever the page says", async () => {
		const message = await reply(FORM);
		const claimed = {
			kind: "form",
			title: "Wire the money",
			fields: [["store", "sqlite"]],
		} as unknown as Frame["answer"];
		await answer(frame(message.id, 0, claimed));
		expect(sent[0]?.text).not.toContain("Wire the money");
	});

	test("text that would start with ! or / is never sent", async () => {
		const message = await reply(SUGGEST);
		const outcome = await answer(
			frame(message.id, 0, { kind: "suggest", fields: [["text", "/compact"]] }),
		);
		expect(outcome).toMatchObject({ ok: false, code: "invalid" });
		expect(sent).toEqual([]);
		expect((await log.get(ROOM, message.id))?.answers).toBeUndefined();
	});

	test("only an owner answers, and only for a writable room of the app", async () => {
		const message = await reply(OPTIONS);
		const member = { ...OWNER, tier: "member" } as unknown as Answerer;
		expect(
			await answer(frame(message.id, 0, pick("SQLite")), member),
		).toMatchObject({ ok: false, code: "forbidden" });
		const noActor = { ...OWNER, actor: undefined } as unknown as Answerer;
		expect(
			await answer(frame(message.id, 0, pick("SQLite")), noActor),
		).toMatchObject({ ok: false, code: "forbidden" });
		expect(
			await answer({
				...frame(message.id, 0, pick("SQLite")),
				room: "app:agent.nobody",
			}),
		).toMatchObject({
			ok: false,
			code: "unknown_room",
		});
		readOnly = true;
		expect(await answer(frame(message.id, 0, pick("SQLite")))).toMatchObject({
			ok: false,
			code: "read_only",
		});
		readOnly = false;
		started = false;
		expect(await answer(frame(message.id, 0, pick("SQLite")))).toMatchObject({
			ok: false,
			code: "not_accepted",
		});
		expect(sent).toEqual([]);
		expect((await log.get(ROOM, message.id))?.answers).toBeUndefined();
	});

	test("only an agent's plain reply of the current conversation takes an answer", async () => {
		const owner = await log.append({
			room: ROOM,
			kind: "owner",
			author: "Ada",
			text: OPTIONS,
		});
		const note = await log.append({
			room: ROOM,
			kind: "owner",
			author: "Ada",
			text: OPTIONS,
			note: true,
		});
		const intercom = await log.append({
			room: ROOM,
			kind: "agent",
			agent: "guide",
			author: "Guide",
			text: OPTIONS,
			intercom: { kind: "sent", peer: { name: "scout", displayName: "Scout" } },
		});
		const system = await log.append({
			room: ROOM,
			kind: "system",
			author: "Server",
			text: OPTIONS,
		});
		for (const message of [owner, note, intercom, system])
			expect(await answer(frame(message.id, 0, pick("SQLite")))).toMatchObject({
				ok: false,
				code: "unanswerable",
			});
		expect(await answer(frame(2 ** 40, 0, pick("SQLite")))).toMatchObject({
			ok: false,
			code: "unanswerable",
		});
		// A reply from before the conversation started over is archived.
		const old = await reply(OPTIONS);
		await log.append({
			room: ROOM,
			kind: "system",
			author: "Server",
			text: "Conversation started over",
		});
		expect(await answer(frame(old.id, 0, pick("SQLite")))).toMatchObject({
			ok: false,
			code: "unanswerable",
		});
		const fresh = await reply(OPTIONS);
		expect((await answer(frame(fresh.id, 0, pick("SQLite")))).ok).toBe(true);
		expect(sent).toHaveLength(1);
	});

	test("when sending fails the block is open again and the answer can be given", async () => {
		const message = await reply(OPTIONS);
		sendError = new Error("the host went away");
		expect(await answer(frame(message.id, 0, pick("SQLite")))).toMatchObject({
			ok: false,
			code: "not_accepted",
		});
		expect((await log.get(ROOM, message.id))?.answers).toBeUndefined();
		// Every socket gets the row without the answer, so a device refused as answered reopens.
		expect(shown.at(-1)?.id).toBe(message.id);
		expect(shown.at(-1)?.answers).toBeUndefined();
		sendError = undefined;
		expect((await answer(frame(message.id, 0, pick("SQLite")))).ok).toBe(true);
	});

	test("cancelling the queued answer reopens the block", async () => {
		const message = await reply(OPTIONS);
		const first = await answer(frame(message.id, 0, pick("SQLite")));
		if (!first.ok) throw new Error("not answered");
		const reopened = await log.reopenAnswer(ROOM, first.message.id);
		expect(reopened?.id).toBe(message.id);
		expect(reopened?.answers).toBeUndefined();
		expect(await log.reopenAnswer(ROOM, first.message.id)).toBeUndefined();
		expect((await answer(frame(message.id, 0, pick("Postgres")))).ok).toBe(
			true,
		);
	});

	test("deleting the message takes its answers with it", async () => {
		const message = await reply(OPTIONS);
		await answer(frame(message.id, 0, pick("SQLite")));
		await log.remove(ROOM, message.id);
		const rows =
			await sql`SELECT 1 FROM web_room_block_answers WHERE message_id = ${message.id}`;
		expect(rows).toHaveLength(0);
	});
});
