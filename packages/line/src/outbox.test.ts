import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import { LineApi } from "./api.ts";
import type { LineOutboxResultEvent } from "./messages.ts";
import { type OutboxOptions, PgOutbox } from "./outbox.ts";
import { OutboxWorker } from "./outbox-worker.ts";
import { QuotaGate } from "./quota.ts";
import { PgSources } from "./sources.ts";
import {
	CHANNEL_ID,
	fakeLine,
	GROUP,
	OTHER_GROUP,
	SECRET,
} from "./testing/line-fake.ts";
import { freshPool, truncateAll } from "./testing/pool.ts";
import { TokenSource } from "./token.ts";

const BASE = Date.parse("2026-10-13T00:00:00Z");
const USER = "line:user:Uuser0001";
const text = (value: string) => ({ type: "text", text: value });
const SENDER = {
	name: "Ada｜Support",
	iconUrl: "https://icons.example.test/staff.png",
};
const OTHER_SENDER = {
	name: "Grace",
	iconUrl: "https://icons.example.test/staff.png",
};

interface Row {
	id: string | number;
	source_key: string;
	sender_name: string | null;
	messages: { type: string; text?: string; sender?: unknown }[] | null;
	message_count: number;
	origin_refs: (string | null)[];
	retry_key: string;
	recipients: number | null;
	status: string;
	attempts: number;
	last_error_code: string | null;
	line_request_id: string | null;
	notified_at: Date | null;
}

describeDb("the outbox", () => {
	let sql: SQL;
	let clock = 0;
	const now = () => new Date(BASE + clock);
	const logs = recordingLogger();
	let fake = fakeLine();
	let results: LineOutboxResultEvent[] = [];
	let hearing = true;
	let emitError: Error | undefined;
	let outbox: PgOutbox;
	let worker: OutboxWorker;
	let quota: QuotaGate;

	const build = (options: Partial<OutboxOptions> = {}, monthlyCap?: number) => {
		const api = new LineApi({
			tokens: new TokenSource({
				credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
				fetch: fake.fetch,
			}),
			fetch: fake.fetch,
		});
		const sources = new PgSources(sql, () => api, now);
		quota = new QuotaGate({
			api,
			now,
			...(monthlyCap === undefined ? {} : { options: { monthlyCap } }),
		});
		outbox = new PgOutbox({ sql, now, sources, options });
		worker = new OutboxWorker({
			sql,
			logger: logs.logger,
			now,
			api,
			quota,
			sources,
			random: () => 1,
			emit: async (event) => {
				if (!hearing) return false;
				if (emitError) throw emitError;
				results.push(event);
				return true;
			},
			options,
		});
	};
	const rows = async () =>
		Array.from(await sql`SELECT * FROM line_outbox ORDER BY id`) as Row[];
	const allow = async (key: string, status = "allowed") => {
		const kind = key.split(":")[1];
		await sql`INSERT INTO line_sources (source_key, kind, status, first_seen_at, last_seen_at, status_changed_at)
			VALUES (${key}, ${kind}, ${status}, ${now()}, ${now()}, ${now()})
			ON CONFLICT (source_key) DO UPDATE SET status = ${status}`;
	};
	/** Sends everything that is due, one push at a time. */
	const drain = async () => {
		let sent = 0;
		while (await worker.runOnce()) sent++;
		return sent;
	};

	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		clock = 0;
		fake = fakeLine();
		results = [];
		hearing = true;
		emitError = undefined;
		logs.lines.length = 0;
		build();
		await allow(GROUP);
		await allow(OTHER_GROUP);
		await allow(USER);
	});
	afterAll(async () => {
		await sql?.close();
	});

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
		clock = 900;
		await outbox.enqueue(GROUP, [text("two"), text("three")], {
			sender: SENDER,
			origin: "b",
		});
		clock = 1_900;
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
		clock = 2_000;
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
		clock = 2_000;
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
		clock = 2_000;
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
		clock = 2_000;
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

	test("a sent push loses its objects, keeps LINE's request id, and the subscriber is told once per origin", async () => {
		await outbox.enqueue(GROUP, [text("secret words")], { origin: "draft-1" });
		await outbox.enqueue(GROUP, [text("more")], { origin: "draft-2" });
		await outbox.enqueue(GROUP, [text("none")]);
		clock = 2_000;
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
			},
			{
				type: "outboxResult",
				sourceKey: GROUP,
				originRef: "draft-2",
				status: "sent",
				errorCode: null,
			},
			{
				type: "outboxResult",
				sourceKey: GROUP,
				originRef: null,
				status: "sent",
				errorCode: null,
			},
		]);
		// Told once: a second look finds nothing.
		expect(await worker.notify()).toBe(0);
		expect(results).toHaveLength(3);
	});

	test("a push that failed is retried under the same key, and 429 and 5xx back off", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [pushRow] = await rows();
		clock = 2_000;
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
		clock += 5_000;
		expect(await worker.runOnce()).toBe(true);
		[row] = await rows();
		expect(row).toMatchObject({
			status: "queued",
			attempts: 2,
			last_error_code: "http_429",
		});
		// 429 asked for 90 seconds, which is longer than the backoff.
		clock += 60_000;
		expect(await worker.runOnce()).toBe(false);
		clock += 31_000;
		expect(await worker.runOnce()).toBe(true);
		clock += 3_600_000;
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
		clock = 2_000;
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
		clock = 2_000;
		fake.breakNetwork(true);
		await worker.runOnce();
		expect(await rows()).toMatchObject([
			{ status: "queued", attempts: 1, last_error_code: "token_unreachable" },
		]);
		fake.breakNetwork(false);
		clock += 5_000;
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
		clock = 2_000;
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
		clock += 3_600_000;
		expect(await worker.runOnce()).toBe(false);
		expect(fake.pushes).toHaveLength(4);
	});

	test("a retry key is reused for 24 hours and a push still unsent after that is dead, never sent under a new key", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [row] = await rows();
		clock = 2_000;
		fake.pushScript.push(500, 500);
		await worker.runOnce();
		clock += 23 * 3_600_000;
		await worker.runOnce();
		expect((await rows())[0]?.status).toBe("queued");
		expect(fake.pushes.map((p) => p.retryKey)).toEqual([
			row?.retry_key,
			row?.retry_key,
		]);
		clock += 2 * 3_600_000;
		await worker.runOnce();
		expect(await rows()).toMatchObject([
			{ status: "dead", last_error_code: "retry_key_expired", messages: null },
		]);
		expect(fake.pushes).toHaveLength(2);
		clock += 3_600_000;
		expect(await worker.runOnce()).toBe(false);
	});

	test("a push whose first request was cut short by a stop still expires with its key, and is never gathered into", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		clock = 2_000;
		// What a stop leaves behind: the attempt is not counted, the key has been used.
		await sql`UPDATE line_outbox SET attempts = 0, first_attempt_at = ${now()}`;
		clock += 25 * 3_600_000;
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
		clock = 2_000;
		fake.pushScript.push(500, 502, 503);
		for (let i = 0; i < 3; i++) {
			await worker.runOnce();
			clock += 3_600_000;
		}
		expect(await rows()).toMatchObject([
			{ status: "dead", attempts: 3, last_error_code: "http_503" },
		]);
	});

	test("a group's push counts its members, reservations count before LINE does, and a push over the budget is refused unsent", async () => {
		fake.quota = 100;
		fake.members.Cgroup0002 = 40;
		fake.members.Cgroup0001 = 40;
		build({}, 90);
		await outbox.enqueue(GROUP, [text("a")], { origin: "p1" });
		await outbox.enqueue(OTHER_GROUP, [text("b")], { origin: "p2" });
		await outbox.enqueue(USER, [text("c")], { origin: "p3" });
		clock = 2_000;
		await drain();
		// 40 + 40 fit in the cap of 90; the user's one more recipient is 81, and fits too.
		expect(fake.pushes).toHaveLength(3);
		expect(quota.reserved()).toBe(81);
		await outbox.enqueue(GROUP, [text("d")], { origin: "p4" });
		clock += 2_000;
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
		});
		// LINE's own count (81) is read after a minute; the reservations are dropped, the sum is the same.
		clock += 61_000;
		await outbox.enqueue(USER, [text("e")]);
		clock += 2_000;
		await worker.runOnce();
		expect(fake.pushes).toHaveLength(4);
		expect(quota.reserved()).toBe(1);
		fake.usage = 90;
		clock += 61_000;
		await outbox.enqueue(USER, [text("f")]);
		clock += 2_000;
		await worker.runOnce();
		expect((await rows()).at(-1)?.status).toBe("refused");
	});

	test("a push whose outcome is unknown stays reserved like a sent one, a refused one does not (R6-F005)", async () => {
		fake.quota = 100;
		build({}, 90);
		await outbox.enqueue(USER, [text("a")], { origin: "p1" });
		await outbox.enqueue(OTHER_GROUP, [text("b")], { origin: "p2" });
		fake.members.Cgroup0002 = 10;
		clock = 2_000;
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
		clock = 2_000;
		await worker.runOnce();
		expect((await rows())[0]?.status).toBe("refused");
		fake.quota = 100;
		fake.usage = 0;
		fake.failQuota(500);
		build({}, 1000);
		await outbox.enqueue(USER, [text("b")]);
		clock += 2_000;
		await worker.runOnce();
		expect((await rows())[1]).toMatchObject({
			status: "queued",
			attempts: 1,
			last_error_code: "http_500",
		});
		expect(fake.pushes).toHaveLength(0);
		fake.failQuota(undefined);
		clock += 5_000;
		await worker.runOnce();
		expect((await rows())[1]?.status).toBe("sent");
	});

	test("a chat that was blocked after the push was queued gets nothing", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		await allow(GROUP, "blocked");
		clock = 2_000;
		await worker.runOnce();
		expect(await rows()).toMatchObject([
			{ status: "dead", last_error_code: "source_not_allowed", messages: null },
		]);
		expect(fake.pushes).toHaveLength(0);
	});

	test("a push left in hand by a process that died goes back and is sent again under its key", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		const [row] = await rows();
		clock = 2_000;
		await sql`UPDATE line_outbox SET status = 'sending', claimed_at = ${now()}, attempts = 1, first_attempt_at = ${now()}`;
		expect(await worker.recoverLeases()).toBe(0);
		clock += 3 * 60_000;
		expect(await worker.recoverLeases()).toBe(1);
		await worker.runOnce();
		expect(await rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
		expect(fake.pushes[0]?.retryKey).toBe(row?.retry_key);
	});

	test("results wait while nobody listens, and a subscriber that fails is told again later", async () => {
		await outbox.enqueue(GROUP, [text("hi")], { origin: "x" });
		clock = 2_000;
		await drain();
		hearing = false;
		expect(await worker.notify()).toBe(0);
		expect((await rows())[0]?.notified_at).toBeNull();
		hearing = true;
		expect(await worker.notify()).toBe(1);
		expect(results).toHaveLength(1);

		await outbox.enqueue(GROUP, [text("again")], { origin: "y" });
		clock += 2_000;
		await drain();
		emitError = new Error("subscriber broke");
		expect(await worker.notify()).toBe(0);
		expect((await rows())[1]).toMatchObject({
			notify_attempts: 1,
			notified_at: null,
		});
		expect(results).toHaveLength(1);
		emitError = undefined;
		// Not told again before its backoff is over; then the working worker tells it.
		expect(await worker.notify()).toBe(0);
		clock += 3_600_000;
		expect(await worker.notify()).toBe(1);
		expect(results.at(-1)).toMatchObject({ originRef: "y", status: "sent" });
	});

	test("the message text, the access token and the retry key appear in no log line", async () => {
		await outbox.enqueue(GROUP, [text("PRIVATE-WORDS")], { sender: SENDER });
		const [row] = await rows();
		clock = 2_000;
		fake.pushScript.push(500, {
			status: 400,
			body: { message: "PRIVATE-WORDS echoed", details: [] },
		});
		await worker.runOnce();
		clock += 5_000;
		await worker.runOnce();
		const everything = JSON.stringify(logs.lines);
		expect(logs.lines.length).toBeGreaterThan(0);
		for (const secret of [
			"PRIVATE-WORDS",
			"access-token-1",
			row?.retry_key ?? "x",
			SECRET,
			"echoed",
		])
			expect(everything).not.toContain(secret);
	});

	test("stopping a push in flight puts it back as it was, and the loop sends what is queued", async () => {
		build({ coalesceMs: 20, pollMs: 10 });
		// The loop runs on real time; the test's clock follows it.
		const ticker = setInterval(() => {
			clock += 10;
		}, 10);
		fake.pushDelayMs = 300;
		await outbox.enqueue(GROUP, [text("hi")]);
		const [row] = await rows();
		await worker.start();
		for (
			let i = 0;
			i < 100 && fake.calls.filter((c) => c.url.endsWith("/push")).length === 0;
			i++
		)
			await Bun.sleep(10);
		expect(worker.busy()).toHaveLength(1);
		await worker.stop();
		expect(worker.busy()).toEqual([]);
		expect(await rows()).toMatchObject([
			{ status: "queued", attempts: 0, last_error_code: "worker_stopped" },
		]);
		fake.pushDelayMs = 0;
		build({ coalesceMs: 20, pollMs: 10 });
		await worker.start();
		for (let i = 0; i < 200 && (await rows())[0]?.status !== "sent"; i++)
			await Bun.sleep(10);
		await worker.stop();
		clearInterval(ticker);
		expect((await rows())[0]?.status).toBe("sent");
		expect(fake.pushes.at(-1)?.retryKey).toBe(row?.retry_key);
		// The loop tells the subscriber too.
		expect(results).toHaveLength(1);
	});
});
