import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { GROUP, OTHER_GROUP } from "./testing/line-fake.ts";
import {
	allow,
	build,
	ctl,
	drain,
	fake,
	now,
	OTHER_SENDER,
	outbox,
	quota,
	results,
	rows,
	SENDER,
	sql,
	text,
	USER,
	useOutboxHarness,
	worker,
} from "./testing/outbox-fixture.ts";

describeDb("the outbox: batching and budget", () => {
	useOutboxHarness();

	test("a sender LINE would refuse, a bad message, a bad key and a chat that is not allowed are refused before anything is queued", async () => {
		const refuse = async (
			key: string,
			messages: unknown[],
			sender?: unknown,
		): Promise<string> => {
			try {
				await outbox.enqueue(key, messages as never, { sender } as never);
			} catch (error) {
				return (error as { code: string }).code;
			}
			return "queued";
		};
		expect(await refuse(GROUP, [text("hi")], { name: "x".repeat(21) })).toBe(
			"bad_sender",
		);
		expect(await refuse(GROUP, [text("hi")], { name: "LINE support" })).toBe(
			"bad_sender",
		);
		expect(
			await refuse(GROUP, [text("hi")], {
				iconUrl: "http://icons.example.test/a.png",
			}),
		).toBe("bad_sender");
		expect(await refuse(GROUP, [])).toBe("bad_messages");
		expect(await refuse(GROUP, [{ text: "no type" }])).toBe("bad_messages");
		expect(await refuse(GROUP, [text("")])).toBe("bad_messages");
		expect(await refuse(GROUP, [text("x".repeat(5001))])).toBe("bad_messages");
		expect(
			await refuse(GROUP, [{ ...text("hi"), sender: { name: "x" } }]),
		).toBe("bad_messages");
		expect(
			await refuse(
				GROUP,
				Array.from({ length: 101 }, () => text("hi")),
			),
		).toBe("bad_messages");
		expect(await refuse("nope", [text("hi")])).toBe("bad_source_key");
		expect(await refuse("line:group:Cunknown", [text("hi")])).toBe(
			"source_not_allowed",
		);
		await allow("line:group:Cblocked", "blocked");
		await allow("line:group:Cpending", "pending");
		expect(await refuse("line:group:Cblocked", [text("hi")])).toBe(
			"source_not_allowed",
		);
		expect(await refuse("line:group:Cpending", [text("hi")])).toBe(
			"source_not_allowed",
		);
		expect(await rows()).toEqual([]);
		// The refusals name the rule and never quote the value.
		const error = await outbox
			.enqueue(GROUP, [text("hi")], { sender: { name: "SECRET".repeat(5) } })
			.catch((e: Error) => e);
		expect((error as Error).message).not.toContain("SECRET");
	});

	test("objects of one chat and one sender queued within two seconds share a push of at most five, in order", async () => {
		await outbox.enqueue(GROUP, [text("one")], { sender: SENDER, origin: "a" });
		ctl.clock = 900;
		await outbox.enqueue(GROUP, [text("two"), text("three")], {
			sender: SENDER,
			origin: "b",
		});
		ctl.clock = 1_900;
		await outbox.enqueue(GROUP, [text("four")], {
			sender: SENDER,
			origin: "a",
		});
		const [push, ...more] = await rows();
		expect(more).toEqual([]);
		expect(push?.messages?.map((m) => m.text)).toEqual([
			"one",
			"two",
			"three",
			"four",
		]);
		expect(push?.message_count).toBe(4);
		expect(push?.origin_refs).toEqual(["a", "b"]);
		// The retry key exists before any attempt; the window is fixed from the first object.
		expect(push?.retry_key).toMatch(/^[0-9a-f-]{36}$/);
		expect(push?.attempts).toBe(0);
		// Not ready until two seconds after the first object, however many came after it.
		expect(await worker.runOnce()).toBe(false);
		ctl.clock = 2_000;
		expect(await worker.runOnce()).toBe(true);
		expect(fake.pushes).toHaveLength(1);
		expect(fake.pushes[0]?.to).toBe("Cgroup0001");
		expect(fake.pushes[0]?.messages).toHaveLength(4);
		// After the window a push is sealed: the next object starts another push.
		await outbox.enqueue(GROUP, [text("five")], { sender: SENDER });
		expect((await rows()).map((r) => r.status)).toEqual(["sent", "queued"]);
	});

	test("more than five objects spill into further pushes, and a full push goes at once", async () => {
		await outbox.enqueue(
			GROUP,
			Array.from({ length: 7 }, (_, i) => text(`m${i}`)),
		);
		const pushes = await rows();
		expect(pushes.map((r) => r.message_count)).toEqual([5, 2]);
		// The full push needs no window; the other waits for it, and goes after the first.
		expect(await drain()).toBe(1);
		ctl.clock = 2_000;
		expect(await drain()).toBe(1);
		expect(fake.pushes.map((p) => p.messages.map((m) => m.text))).toEqual([
			["m0", "m1", "m2", "m3", "m4"],
			["m5", "m6"],
		]);
		// Adding to an open push fills it, and the rest spills over.
		await outbox.enqueue(OTHER_GROUP, [text("a"), text("b"), text("c")]);
		await outbox.enqueue(OTHER_GROUP, [text("d"), text("e"), text("f")]);
		expect(
			(await rows())
				.filter((r) => r.source_key === OTHER_GROUP)
				.map((r) => r.message_count),
		).toEqual([5, 1]);
	});

	test("a different sender, or a different chat, never shares a push, and the order of a chat is kept", async () => {
		await outbox.enqueue(GROUP, [text("a1")], { sender: SENDER });
		await outbox.enqueue(GROUP, [text("b1")], { sender: OTHER_SENDER });
		// Joining the first push would put a2 ahead of b1.
		await outbox.enqueue(GROUP, [text("a2")], { sender: SENDER });
		await outbox.enqueue(GROUP, [text("none")]);
		await outbox.enqueue(OTHER_GROUP, [text("other")], { sender: SENDER });
		const all = await rows();
		expect(
			all.map((r) => [
				r.source_key,
				r.sender_name,
				r.messages?.map((m) => m.text),
			]),
		).toEqual([
			[GROUP, SENDER.name, ["a1"]],
			[GROUP, OTHER_SENDER.name, ["b1"]],
			[GROUP, SENDER.name, ["a2"]],
			[GROUP, null, ["none"]],
			[OTHER_GROUP, SENDER.name, ["other"]],
		]);
		ctl.clock = 2_000;
		await drain();
		expect(
			fake.pushes.map((p) => [p.to, p.messages.map((m) => m.text)]),
		).toEqual([
			["Cgroup0001", ["a1"]],
			["Cgroup0001", ["b1"]],
			["Cgroup0001", ["a2"]],
			["Cgroup0001", ["none"]],
			["Cgroup0002", ["other"]],
		]);
	});

	test("the sender goes on every object of the push, a push without one carries none, and the key goes in the header", async () => {
		await outbox.enqueue(GROUP, [text("a"), text("b")], { sender: SENDER });
		await outbox.enqueue(USER, [text("c")]);
		const [first, second] = await rows();
		ctl.clock = 2_000;
		await drain();
		const [push1, push2] = fake.pushes;
		expect(push1?.messages.map((m) => m.sender)).toEqual([SENDER, SENDER]);
		expect(push1?.retryKey).toBe(first?.retry_key);
		expect(push2?.to).toBe("Uuser0001");
		expect(push2?.messages[0]).toEqual(text("c"));
		expect(push2?.retryKey).toBe(second?.retry_key);
		expect(
			fake.calls.find((c) => c.url.endsWith("/push"))?.authorization,
		).toMatch(/^Bearer access-token-/);
	});

	test("a group's push counts its members, reservations count before LINE does, and a push over the budget is refused unsent", async () => {
		fake.quota = 100;
		fake.members.Cgroup0002 = 40;
		fake.members.Cgroup0001 = 40;
		build({}, 90);
		await outbox.enqueue(GROUP, [text("a")], { origin: "p1" });
		await outbox.enqueue(OTHER_GROUP, [text("b")], { origin: "p2" });
		await outbox.enqueue(USER, [text("c")], { origin: "p3" });
		ctl.clock = 2_000;
		await drain();
		// 40 + 40 fit in the cap of 90; the user's one more recipient is 81, and fits too.
		expect(fake.pushes).toHaveLength(3);
		expect(quota.reserved()).toBe(81);
		await outbox.enqueue(GROUP, [text("d")], { origin: "p4" });
		ctl.clock += 2_000;
		await worker.runOnce();
		// 81 sent and counted + 40 would pass the cap: refused, and nothing was sent for it.
		expect(fake.pushes).toHaveLength(3);
		expect((await rows())[3]).toMatchObject({
			status: "refused",
			last_error_code: "quota_exhausted",
			messages: null,
			recipients: 40,
		});
		await worker.notify();
		expect(results.at(-1)).toEqual({
			type: "outboxResult",
			sourceKey: GROUP,
			originRef: "p4",
			status: "refused",
			errorCode: "quota_exhausted",
			attempts: 1,
		});
		// LINE's own count (81) is read after a minute; the reservations are dropped, the sum is the same.
		ctl.clock += 61_000;
		await outbox.enqueue(USER, [text("e")]);
		ctl.clock += 2_000;
		await worker.runOnce();
		expect(fake.pushes).toHaveLength(4);
		expect(quota.reserved()).toBe(1);
		fake.usage = 90;
		ctl.clock += 61_000;
		await outbox.enqueue(USER, [text("f")]);
		ctl.clock += 2_000;
		await worker.runOnce();
		expect((await rows()).at(-1)?.status).toBe("refused");
	});

	test("a push whose outcome is unknown stays reserved like a sent one, a refused one does not (R6-F005)", async () => {
		fake.quota = 100;
		build({}, 90);
		await outbox.enqueue(USER, [text("a")], { origin: "p1" });
		await outbox.enqueue(OTHER_GROUP, [text("b")], { origin: "p2" });
		fake.members.Cgroup0002 = 10;
		ctl.clock = 2_000;
		fake.pushScript.push(500);
		await worker.runOnce();
		// A 5xx may have been taken by LINE: its recipient is held.
		expect(quota.reserved()).toBe(1);
		fake.pushScript.push(400);
		await worker.runOnce();
		// A definite refusal sends nothing, so nothing of it is held.
		expect(quota.reserved()).toBe(1);
	});

	test("the plan's quota holds when the cap is higher, and a quota that cannot be read backs off instead of refusing", async () => {
		fake.quota = 2;
		fake.usage = 2;
		build({}, 1000);
		await outbox.enqueue(USER, [text("a")]);
		ctl.clock = 2_000;
		await worker.runOnce();
		expect((await rows())[0]?.status).toBe("refused");
		fake.quota = 100;
		fake.usage = 0;
		fake.failQuota(500);
		build({}, 1000);
		await outbox.enqueue(USER, [text("b")]);
		ctl.clock += 2_000;
		await worker.runOnce();
		expect((await rows())[1]).toMatchObject({
			status: "queued",
			attempts: 1,
			last_error_code: "http_500",
		});
		expect(fake.pushes).toHaveLength(0);
		fake.failQuota(undefined);
		ctl.clock += 5_000;
		await worker.runOnce();
		expect((await rows())[1]?.status).toBe("sent");
	});

	test("a chat that was blocked after the push was queued gets nothing", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		await allow(GROUP, "blocked");
		ctl.clock = 2_000;
		await worker.runOnce();
		expect(await rows()).toMatchObject([
			{ status: "dead", last_error_code: "source_not_allowed", messages: null },
		]);
		expect(fake.pushes).toHaveLength(0);
	});

	test("a push left in hand by a process that died goes back and is sent again under its key", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [row] = await rows();
		ctl.clock = 2_000;
		await sql`UPDATE line_outbox SET status = 'sending', claimed_at = ${now()}, attempts = 1, first_attempt_at = ${now()}`;
		expect(await worker.recoverLeases()).toBe(0);
		ctl.clock += 3 * 60_000;
		expect(await worker.recoverLeases()).toBe(1);
		await worker.runOnce();
		expect(await rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
		expect(fake.pushes[0]?.retryKey).toBe(row?.retry_key);
	});
});
