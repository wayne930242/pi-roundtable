import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { LineError } from "./errors.ts";
import {
	advance,
	editOf,
	handled,
	receive,
	row,
	state,
	store,
	unsendOf,
	useInboxHarness,
	worker,
} from "./testing/inbox-fixture.ts";
import { messageEvent } from "./testing/line-fake.ts";

describeDb("the inbox worker: order of one message", () => {
	useInboxHarness();

	test("an unsend ahead of its message waits for it; an edit of a message that never came waits out the grace", async () => {
		await store(
			// The unsend carries an earlier time than the message it removes, as a skewed delivery can.
			{
				...messageEvent({ id: "unsend-1", timestamp: 1000, type: "unsend" }),
				message: undefined,
				unsend: { messageId: "m-text" },
			},
			messageEvent({ id: "text", timestamp: 2000, messageId: "m-text" }),
		);
		const w = worker({ dependencyRetryMs: 5000, messageGraceMs: 600_000 });
		// The unsend is claimed first, finds its message waiting, and goes back without a failure.
		expect(await w.runOnce()).toBe(true);
		expect(handled).toEqual([]);
		expect(await row("unsend-1")).toMatchObject({
			status: "pending",
			attempts: 0,
			requeues: 0,
			last_error_code: "waiting_for_message",
		});
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["text"]);
		advance(5000);
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["text", "unsend-1"]);
		expect(handled[1]?.messageId).toBe("m-text");

		await receive({
			...messageEvent({ id: "edit-1", timestamp: 9000, type: "messageEdited" }),
			message: { id: "m-never", type: "text", text: "edited" },
		});
		advance(5000);
		expect(await w.runOnce()).toBe(true);
		expect(handled.length).toBe(2);
		advance(599_000);
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["text", "unsend-1", "edit-1"]);
	});

	test("R4REV-F001: an unsend waits for an original that keeps failing, however long, and never dies before it settles", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
		);
		let tries = 0;
		state.processor = async (event) => {
			if (event.id === "m1" && ++tries < 6)
				throw new LineError("discord_down", "no");
			handled.push(event);
			return undefined;
		};
		const w = worker({
			maxRequeues: 3,
			dependencyRetryMs: 5000,
			backoffBaseMs: 40_000,
			backoffCapMs: 40_000,
		});
		for (let i = 0; i < 400 && handled.length < 2; i++) {
			await w.runOnce();
			advance(5000);
		}
		expect(handled.map((e) => e.id)).toEqual(["m1", "u1"]);
		expect(await row("u1")).toMatchObject({ status: "done" });
		expect(await row("m1")).toMatchObject({ status: "done", attempts: 6 });
	});

	test("R4REV-F001: an unsend goes on once the original is dead, and the wait it did does not count against the limit", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
		);
		state.processor = async (event) => {
			if (event.id === "m1") throw new LineError("always_fails", "no");
			handled.push(event);
			return undefined;
		};
		const w = worker({
			maxRequeues: 2,
			maxAttempts: 3,
			backoffBaseMs: 20_000,
			backoffCapMs: 20_000,
		});
		for (let i = 0; i < 100 && handled.length < 1; i++) {
			await w.runOnce();
			advance(5000);
		}
		expect(handled.map((e) => e.id)).toEqual(["u1"]);
		expect(await row("m1")).toMatchObject({ status: "dead" });
		expect(await row("u1")).toMatchObject({ status: "done", requeues: 0 });
	});

	test("R4REV-F004: edits of one message run in order even when the earlier one is backing off, while other messages go on", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			editOf("e1", "M1", 2000),
			messageEvent({ id: "other", timestamp: 2500, messageId: "M2" }),
			editOf("e2", "M1", 3000),
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
		const w = worker({ backoffBaseMs: 30_000, dependencyRetryMs: 5000 });
		for (let i = 0; i < 40 && handled.length < 4; i++) {
			await w.runOnce();
			advance(5000);
		}
		const order = handled.map((e) => e.id);
		expect(order.indexOf("e1")).toBeLessThan(order.indexOf("e2"));
		expect(order.indexOf("m1")).toBeLessThan(order.indexOf("e1"));
		// The other message was not held behind the edit that was backing off.
		expect(order.indexOf("other")).toBeLessThan(order.indexOf("e1"));
		expect(order.length).toBe(4);
	});

	test("R4RR-nit: an event waiting for a message that is backing off is looked at again when that message is due, not every few seconds", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
		);
		state.processor = async (event) => {
			handled.push(event);
			if (event.id === "m1") throw new LineError("discord_down", "no");
			return undefined;
		};
		const w = worker({ backoffBaseMs: 600_000, dependencyRetryMs: 5000 });
		expect(await w.runOnce()).toBe(true);
		const backoffUntil = (await row("m1")).next_attempt_at as Date;
		// u1 is claimed once, finds m1 backing off and sleeps until m1 is due.
		expect(await w.runOnce()).toBe(true);
		const waiting = await row("u1");
		expect(waiting).toMatchObject({ status: "pending", attempts: 0 });
		expect(new Date(waiting.next_attempt_at).getTime()).toBe(
			backoffUntil.getTime(),
		);
	});
});
