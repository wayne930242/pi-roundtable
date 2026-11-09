import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { LineError } from "./errors.ts";
import {
	advance,
	editOf,
	handled,
	membership,
	receive,
	row,
	START,
	sources,
	sql,
	state,
	store,
	unsendOf,
	useInboxHarness,
	worker,
} from "./testing/inbox-fixture.ts";
import { GROUP, messageEvent, OTHER_GROUP } from "./testing/line-fake.ts";

describeDb("the inbox worker: chats that are left or blocked", () => {
	useInboxHarness();

	test("R4REV-F002: after block() an event that fails or asks for later is not handed out again, and loses its payload", async () => {
		for (const outcome of ["throw", "later"] as const) {
			await sql`TRUNCATE line_inbox, line_sources`;
			handled.length = 0;
			await store(messageEvent({ id: "m1", text: "customer words" }));
			state.processor = async (event) => {
				handled.push(event);
				await sources().block(GROUP);
				if (outcome === "throw") throw new LineError("discord_down", "no");
				return { retryInMs: 1000 };
			};
			const w = worker({ backoffBaseMs: 1000 });
			expect(await w.runOnce()).toBe(true);
			advance(2 * 3_600_000);
			expect(await w.runOnce()).toBe(false);
			expect(handled.map((e) => e.id)).toEqual(["m1"]);
			expect(await row("m1")).toMatchObject({
				status: "skipped",
				payload: null,
				last_error_code: "source_blocked",
			});
		}
	});

	test("R4REV-F002: a pending event of a blocked chat is dropped at the claim, and a chat that is not allowed hands out only its join and leave", async () => {
		await store(
			messageEvent({ id: "m1", text: "customer words", timestamp: 1000 }),
			{ ...messageEvent({ id: "j1", timestamp: 2000 }), type: "join" },
		);
		await sql`UPDATE line_sources SET status = 'left' WHERE source_key = ${GROUP}`;
		const w = worker();
		// The message of a chat the bot left is dropped with its payload; the join behind it still goes out.
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["j1"]);
		expect(await row("m1")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_left",
		});
		await sql`UPDATE line_sources SET status = 'allowed' WHERE source_key = ${GROUP}`;
		await receive(messageEvent({ id: "m2", timestamp: 3000 }));
		await sql`UPDATE line_sources SET status = 'blocked' WHERE source_key = ${GROUP}`;
		expect(await w.runOnce()).toBe(false);
		expect(handled.map((e) => e.id)).toEqual(["j1"]);
		expect(await row("m2")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_blocked",
		});
	});

	test("R4RR-F003: an event backing off when the bot leaves is dropped with its payload and never surfaces after a rejoin", async () => {
		const membership = (id: string, type: string, timestamp: number) => ({
			...messageEvent({ id, timestamp, type }),
			message: undefined,
		});
		await store(
			messageEvent({ id: "m1", text: "customer words", timestamp: 1000 }),
		);
		state.processor = async (event) => {
			handled.push(event);
			if (event.id === "m1") throw new LineError("discord_down", "no");
			return undefined;
		};
		const w = worker({ backoffBaseMs: 60_000 });
		expect(await w.runOnce()).toBe(true);
		expect(await row("m1")).toMatchObject({ status: "pending" });
		// The bot is removed while m1 waits for its retry.
		await receive(membership("lv", "leave", 2000));
		expect(await w.runOnce()).toBe(true);
		expect((await sources().get(GROUP))?.status).toBe("left");
		expect(await row("m1")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_left",
		});
		// Added back and allowed again: the old message does not come back.
		await receive(membership("jn", "join", 3000));
		expect(await w.runOnce()).toBe(true);
		await sources().allow(GROUP);
		advance(2 * 3_600_000);
		expect(await w.runOnce()).toBe(false);
		expect(handled.map((e) => e.id)).toEqual(["m1", "lv", "jn"]);
		expect(await row("m1")).toMatchObject({ status: "skipped", payload: null });
	});

	test("R4RR-F003: the claim drops what an undecided chat or a chat the bot left still holds, apart from join and leave", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000 }),
			messageEvent({ id: "m2", timestamp: 1100, group: "Cgroup0002" }),
		);
		await sql`UPDATE line_inbox SET next_attempt_at = ${new Date(START.getTime() + 3_600_000)}`;
		await sql`UPDATE line_sources SET status = 'left' WHERE source_key = ${GROUP}`;
		await sql`UPDATE line_sources SET status = 'pending' WHERE source_key = ${OTHER_GROUP}`;
		expect(await worker().runOnce()).toBe(false);
		expect(await row("m1")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_left",
		});
		expect(await row("m2")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_pending",
		});
	});

	test("N-F001: an unsend backing off when the bot leaves is still delivered (N1a)", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
		);
		let failed = false;
		state.processor = async (event) => {
			if (event.id === "u1" && !failed) {
				failed = true;
				throw new LineError("discord_down", "no");
			}
			handled.push(event);
			return undefined;
		};
		const w = worker({ backoffBaseMs: 60_000 });
		expect(await w.runOnce()).toBe(true);
		expect(await w.runOnce()).toBe(true);
		expect(await row("u1")).toMatchObject({ status: "pending", attempts: 1 });
		await receive(membership("lv", "leave", 3000));
		expect(await w.runOnce()).toBe(true);
		expect((await sources().get(GROUP))?.status).toBe("left");
		// The unsend is kept, with its payload, while everything else of the chat would be dropped.
		expect(await row("u1")).toMatchObject({ status: "pending" });
		expect((await row("u1")).payload).not.toBeNull();
		advance(120_000);
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["m1", "lv", "u1"]);
		expect(await row("u1")).toMatchObject({ status: "done", attempts: 2 });
	});

	test("N-F001: an unsend waiting on an edit that is backing off survives the leave, and the edit is the one dropped (N1b)", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			editOf("e1", "M1", 2000),
			unsendOf("u1", "M1", 3000),
		);
		let failed = false;
		state.processor = async (event) => {
			if (event.id === "e1" && !failed) {
				failed = true;
				throw new LineError("discord_down", "no");
			}
			handled.push(event);
			return undefined;
		};
		const w = worker({ backoffBaseMs: 60_000, dependencyRetryMs: 5000 });
		expect(await w.runOnce()).toBe(true); // m1
		expect(await w.runOnce()).toBe(true); // e1 fails and backs off
		expect(await w.runOnce()).toBe(true); // u1 finds e1 open and waits
		expect(await row("u1")).toMatchObject({
			status: "pending",
			attempts: 0,
			last_error_code: "waiting_for_message",
		});
		await receive(membership("lv", "leave", 4000));
		expect(await w.runOnce()).toBe(true);
		expect(await row("e1")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_left",
		});
		expect(await row("u1")).toMatchObject({ status: "pending" });
		advance(120_000);
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["m1", "lv", "u1"]);
		expect(await row("u1")).toMatchObject({ status: "done" });
	});

	test("N-F001: at the claim a left or undecided chat hands out an unsend and drops a message, and block() still drops a waiting unsend", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
			messageEvent({ id: "m2", timestamp: 3000, messageId: "M2" }),
		);
		await sql`UPDATE line_inbox SET status = 'done', payload = NULL WHERE webhook_event_id = 'm1'`;
		await sql`UPDATE line_sources SET status = 'pending' WHERE source_key = ${GROUP}`;
		const w = worker();
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["u1"]);
		expect(await row("m2")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_pending",
		});
		// block() is unchanged: it drops a waiting unsend like anything else.
		await sql`UPDATE line_sources SET status = 'allowed' WHERE source_key = ${GROUP}`;
		await receive(unsendOf("u2", "M1", 4000));
		await sources().block(GROUP);
		expect(await row("u2")).toMatchObject({
			status: "skipped",
			payload: null,
			last_error_code: "source_blocked",
		});
	});
});
