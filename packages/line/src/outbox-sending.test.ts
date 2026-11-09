import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { GROUP, OTHER_GROUP } from "./testing/line-fake.ts";
import {
	build,
	ctl,
	drain,
	fake,
	now,
	OTHER_SENDER,
	outbox,
	results,
	rows,
	SENDER,
	sql,
	text,
	useOutboxHarness,
	worker,
} from "./testing/outbox-fixture.ts";

describeDb("the outbox: sending and retries", () => {
	useOutboxHarness();

	test("a sent push loses its objects, keeps LINE's request id, and the subscriber is told once per origin", async () => {
		await outbox.enqueue(GROUP, [text("secret words")], { origin: "draft-1" });
		await outbox.enqueue(GROUP, [text("more")], { origin: "draft-2" });
		await outbox.enqueue(GROUP, [text("none")]);
		ctl.clock = 2_000;
		await drain();
		const [push] = await rows();
		expect(push).toMatchObject({
			status: "sent",
			messages: null,
			line_request_id: "req-1",
			recipients: 3,
			last_error_code: null,
		});
		expect(await worker.notify()).toBe(1);
		expect(results).toEqual([
			{
				type: "outboxResult",
				sourceKey: GROUP,
				originRef: "draft-1",
				status: "sent",
				errorCode: null,
				attempts: 1,
			},
			{
				type: "outboxResult",
				sourceKey: GROUP,
				originRef: "draft-2",
				status: "sent",
				errorCode: null,
				attempts: 1,
			},
			{
				type: "outboxResult",
				sourceKey: GROUP,
				originRef: null,
				status: "sent",
				errorCode: null,
				attempts: 1,
			},
		]);
		// Told once: a second look finds nothing.
		expect(await worker.notify()).toBe(0);
		expect(results).toHaveLength(3);
	});

	test("a push that failed is retried under the same key, and 429 and 5xx back off", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [pushRow] = await rows();
		ctl.clock = 2_000;
		fake.pushScript.push(
			500,
			{ status: 429, headers: { "retry-after": "90" } },
			503,
		);
		expect(await worker.runOnce()).toBe(true);
		let [row] = await rows();
		expect(row).toMatchObject({
			status: "queued",
			attempts: 1,
			last_error_code: "http_500",
		});
		// Backing off: not due yet, and nothing else is sent meanwhile.
		expect(await worker.runOnce()).toBe(false);
		ctl.clock += 5_000;
		expect(await worker.runOnce()).toBe(true);
		[row] = await rows();
		expect(row).toMatchObject({
			status: "queued",
			attempts: 2,
			last_error_code: "http_429",
		});
		// 429 asked for 90 seconds, which is longer than the backoff.
		ctl.clock += 60_000;
		expect(await worker.runOnce()).toBe(false);
		ctl.clock += 31_000;
		expect(await worker.runOnce()).toBe(true);
		ctl.clock += 3_600_000;
		expect(await worker.runOnce()).toBe(true);
		[row] = await rows();
		expect(row).toMatchObject({
			status: "sent",
			attempts: 4,
			last_error_code: null,
		});
		expect(fake.pushes.map((p) => p.status)).toEqual([500, 429, 503, 200]);
		expect(new Set(fake.pushes.map((p) => p.retryKey))).toEqual(
			new Set([pushRow?.retry_key]),
		);
		expect(pushRow?.retry_key).toBeDefined();
	});

	test("a push LINE already has under the key (409) is sent, not failed", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [row] = await rows();
		if (!row) throw new Error("no push");
		// LINE took the first request but the answer never came back; the retry meets 409.
		fake.acceptedKeys.add(row.retry_key);
		ctl.clock = 2_000;
		await drain();
		expect(fake.pushes.map((p) => p.status)).toEqual([409]);
		expect(await rows()).toMatchObject([
			{ status: "sent", last_error_code: null, messages: null },
		]);
		await worker.notify();
		expect(results[0]).toMatchObject({ status: "sent", errorCode: null });
	});

	test("a push with no answer is retried under the same key", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [row] = await rows();
		ctl.clock = 2_000;
		fake.breakNetwork(true);
		await worker.runOnce();
		expect(await rows()).toMatchObject([
			{ status: "queued", attempts: 1, last_error_code: "token_unreachable" },
		]);
		fake.breakNetwork(false);
		ctl.clock += 5_000;
		await worker.runOnce();
		expect(await rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
		expect(fake.pushes[0]?.retryKey).toBe(row?.retry_key);
	});

	test("any other 4xx is dead with LINE's code, a refused sender is named, and the chat goes on", async () => {
		await outbox.enqueue(GROUP, [text("one")], {
			sender: SENDER,
			origin: "o1",
		});
		await outbox.enqueue(GROUP, [text("two")], {
			sender: OTHER_SENDER,
			origin: "o2",
		});
		await outbox.enqueue(GROUP, [text("three")], { origin: "o3" });
		await outbox.enqueue(GROUP, [text("four")], {
			sender: SENDER,
			origin: "o4",
		});
		const refusal = (property: string) => ({
			status: 400,
			body: {
				message: "The request body has 1 error(s)",
				details: [{ message: "Invalid", property }],
			},
		});
		fake.pushScript.push(
			refusal("messages[0].sender.name"),
			refusal("messages[0].sender.iconUrl"),
			{ status: 400, body: { message: "bad" } },
			403,
		);
		ctl.clock = 2_000;
		await drain();
		expect(
			(await rows()).map((r) => [
				r.status,
				r.last_error_code,
				r.messages,
				r.attempts,
			]),
		).toEqual([
			["dead", "sender_name_refused", null, 1],
			["dead", "sender_icon_refused", null, 1],
			["dead", "http_400", null, 1],
			["dead", "http_403", null, 1],
		]);
		await worker.notify();
		expect(results.map((r) => [r.originRef, r.status, r.errorCode])).toEqual([
			["o1", "dead", "sender_name_refused"],
			["o2", "dead", "sender_icon_refused"],
			["o3", "dead", "http_400"],
			["o4", "dead", "http_403"],
		]);
		// A dead push does not hold the pushes behind it, and is never retried.
		ctl.clock += 3_600_000;
		expect(await worker.runOnce()).toBe(false);
		expect(fake.pushes).toHaveLength(4);
	});

	test("a retry key is reused for 24 hours and a push still unsent after that is dead, never sent under a new key", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [row] = await rows();
		ctl.clock = 2_000;
		fake.pushScript.push(500, 500);
		await worker.runOnce();
		ctl.clock += 23 * 3_600_000;
		await worker.runOnce();
		expect((await rows())[0]?.status).toBe("queued");
		expect(fake.pushes.map((p) => p.retryKey)).toEqual([
			row?.retry_key,
			row?.retry_key,
		]);
		ctl.clock += 2 * 3_600_000;
		await worker.runOnce();
		expect(await rows()).toMatchObject([
			{ status: "dead", last_error_code: "retry_key_expired", messages: null },
		]);
		expect(fake.pushes).toHaveLength(2);
		ctl.clock += 3_600_000;
		expect(await worker.runOnce()).toBe(false);
	});

	test("a push whose first request was cut short by a stop still expires with its key, and is never gathered into", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		ctl.clock = 2_000;
		// What a stop leaves behind: the attempt is not counted, the key has been used.
		await sql`UPDATE line_outbox SET attempts = 0, first_attempt_at = ${now()}`;
		ctl.clock += 25 * 3_600_000;
		await worker.runOnce();
		expect(await rows()).toMatchObject([
			{ status: "dead", last_error_code: "retry_key_expired", messages: null },
		]);
		expect(fake.pushes).toHaveLength(0);
		await sql`TRUNCATE line_outbox`;
		await outbox.enqueue(GROUP, [text("a")]);
		await sql`UPDATE line_outbox SET attempts = 0, first_attempt_at = ${now()}`;
		await outbox.enqueue(GROUP, [text("b")]);
		expect(await rows()).toHaveLength(2);
	});

	test("a push that keeps failing is dead after the allowed attempts, with the last code", async () => {
		build({ maxAttempts: 3 });
		await outbox.enqueue(GROUP, [text("hi")]);
		ctl.clock = 2_000;
		fake.pushScript.push(500, 502, 503);
		for (let i = 0; i < 3; i++) {
			await worker.runOnce();
			ctl.clock += 3_600_000;
		}
		expect(await rows()).toMatchObject([
			{ status: "dead", attempts: 3, last_error_code: "http_503" },
		]);
	});

	test("the result event carries how many tries the push took", async () => {
		await outbox.enqueue(GROUP, [text("one")], { origin: "a" });
		ctl.clock = 2_000;
		fake.pushScript.push({
			status: 400,
			body: { message: "bad", details: [] },
		});
		await worker.runOnce();
		await worker.notify();
		expect(results).toEqual([
			{
				type: "outboxResult",
				sourceKey: GROUP,
				originRef: "a",
				status: "dead",
				errorCode: "http_400",
				attempts: 1,
			},
		]);
		await outbox.enqueue(OTHER_GROUP, [text("two")], { origin: "b" });
		ctl.clock += 2_000;
		fake.pushScript.push(500, {
			status: 400,
			body: { message: "bad", details: [] },
		});
		await worker.runOnce();
		ctl.clock += 3_600_000;
		await worker.runOnce();
		await worker.notify();
		expect(results.at(-1)).toMatchObject({
			originRef: "b",
			status: "dead",
			errorCode: "http_400",
			attempts: 2,
		});
	});
});
