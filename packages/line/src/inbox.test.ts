import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import { LineError } from "./errors.ts";
import { parseWebhook } from "./events.ts";
import {
	backoffMs,
	type InboxEvent,
	type InboxOptions,
	type InboxProcessor,
	InboxWorker,
} from "./inbox.ts";
import { persistEvents } from "./intake.ts";
import { PgSources } from "./sources.ts";
import { body, GROUP, messageEvent, OTHER_GROUP } from "./testing/line-fake.ts";
import { freshPool } from "./testing/pool.ts";

const START = new Date("2026-10-13T00:00:00Z");

test("backoff doubles from the base to the cap, and jitter keeps it in the upper half", () => {
	const options = { backoffBaseMs: 1000, backoffCapMs: 60_000 };
	expect(
		[1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffMs(n, options, () => 1)),
	).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
	expect(backoffMs(3, options, () => 0)).toBe(2000);
	for (let i = 0; i < 50; i++) {
		const ms = backoffMs(4, options);
		expect(ms).toBeGreaterThanOrEqual(4000);
		expect(ms).toBeLessThanOrEqual(8000);
	}
});

describeDb("the inbox worker", () => {
	let sql: SQL;
	let time = START;
	let handled: InboxEvent[] = [];
	let processor: InboxProcessor | undefined;
	const logs = recordingLogger();
	const advance = (ms: number) => {
		time = new Date(time.getTime() + ms);
	};
	const sources = () =>
		new PgSources(
			sql,
			() => ({}) as never,
			() => time,
		);
	const worker = (options: Partial<InboxOptions> = {}) =>
		new InboxWorker({
			sql,
			logger: logs.logger,
			now: () => time,
			sources: sources(),
			processor: () => processor,
			random: () => 1,
			options: { pollMs: 20, ...options },
		});
	const receive = async (...events: Record<string, unknown>[]) =>
		persistEvents(
			sql,
			(await parseWebhook(new TextEncoder().encode(body(...events)))).events,
			time,
		);
	/** Allows the two test groups, then stores `events`. */
	const store = async (...events: Record<string, unknown>[]) => {
		await receive(
			messageEvent({ id: "seed-a" }),
			messageEvent({ id: "seed-b", group: "Cgroup0002" }),
		);
		await sources().allow(GROUP);
		await sources().allow(OTHER_GROUP);
		await receive(...events);
	};
	const row = async (id: string) =>
		(await sql`SELECT * FROM line_inbox WHERE webhook_event_id = ${id}`)[0];

	beforeEach(async () => {
		sql ??= await freshPool();
		await sql`TRUNCATE line_inbox, line_sources`;
		time = START;
		handled = [];
		processor = async (event) => {
			handled.push(event);
			return undefined;
		};
		logs.lines.length = 0;
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("events of a chat go out oldest first by LINE's time, and a finished one loses its payload", async () => {
		await store(
			messageEvent({ id: "late", timestamp: 3000 }),
			messageEvent({ id: "early", timestamp: 1000 }),
			messageEvent({ id: "middle", timestamp: 2000 }),
		);
		const w = worker();
		while (await w.runOnce());
		expect(handled.map((e) => e.id)).toEqual(["early", "middle", "late"]);
		expect(handled[0]).toMatchObject({
			type: "message",
			sourceKey: GROUP,
			messageId: "m-early",
			attempt: 1,
		});
		expect(handled[0]?.payload).toMatchObject({
			message: { text: "hello there" },
		});
		expect(await row("early")).toMatchObject({
			status: "done",
			payload: null,
			attempts: 1,
		});
	});

	test("with no processor attached nothing is claimed and nothing is lost", async () => {
		await store(messageEvent({ id: "waiting" }));
		processor = undefined;
		expect(await worker().runOnce()).toBe(false);
		expect(await row("waiting")).toMatchObject({ status: "pending" });
		expect((await row("waiting")).payload.message.text).toBe("hello there");
	});

	test("no chat has two events in hand at once, and other chats go on", async () => {
		await store(
			messageEvent({ id: "g1-a", timestamp: 1000 }),
			messageEvent({ id: "g1-b", timestamp: 2000 }),
			messageEvent({ id: "g2-a", timestamp: 3000, group: "Cgroup0002" }),
		);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		processor = async (event) => {
			handled.push(event);
			if (event.id === "g1-a") await gate;
			return undefined;
		};
		const w = worker();
		const first = w.runOnce();
		for (let i = 0; i < 400 && w.busy().length === 0; i++) await Bun.sleep(10);
		expect(w.busy()).toEqual(["g1-a"]);
		// g1-b waits behind g1-a, so the next claim is the other chat's.
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["g1-a", "g2-a"]);
		expect(await w.runOnce()).toBe(false);
		release();
		await first;
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["g1-a", "g2-a", "g1-b"]);
	});

	test("two workers over many events handle each once and never overlap within a chat", async () => {
		const events = Array.from({ length: 40 }, (_, i) =>
			messageEvent({
				id: `e${i}`,
				timestamp: 1000 + i,
				group: i % 2 === 0 ? "Cgroup0001" : "Cgroup0002",
			}),
		);
		await store(...events);
		const inside = new Map<string, number>();
		let overlap = 0;
		const seen: string[] = [];
		processor = async (event) => {
			const key = event.sourceKey ?? "";
			inside.set(key, (inside.get(key) ?? 0) + 1);
			if ((inside.get(key) ?? 0) > 1) overlap++;
			await Bun.sleep(2);
			seen.push(event.id);
			inside.set(key, (inside.get(key) ?? 1) - 1);
			return undefined;
		};
		const run = async (w: InboxWorker) => {
			for (let idle = 0; idle < 20; idle++) {
				if (!(await w.runOnce())) await Bun.sleep(3);
				else idle = 0;
				if (seen.length === 40) return;
			}
		};
		await Promise.all([run(worker()), run(worker()), run(worker())]);
		expect(overlap).toBe(0);
		expect(seen.length).toBe(40);
		expect(new Set(seen).size).toBe(40);
		// Within one chat the order is LINE's.
		const evens = seen
			.filter((id) => Number(id.slice(1)) % 2 === 0)
			.map((id) => Number(id.slice(1)));
		expect(evens).toEqual([...evens].sort((a, b) => a - b));
	});

	test("a failure is retried after a backoff, stores its code and never its message", async () => {
		await store(messageEvent({ id: "flaky", text: "customer words" }));
		processor = async () => {
			throw new LineError("discord_down", "could not post customer words");
		};
		const w = worker({ backoffBaseMs: 1000 });
		expect(await w.runOnce()).toBe(true);
		const failed = await row("flaky");
		expect(failed).toMatchObject({
			status: "pending",
			attempts: 1,
			last_error_code: "discord_down",
		});
		expect(new Date(failed.next_attempt_at).getTime() - time.getTime()).toBe(
			1000,
		);
		// Not due yet.
		expect(await w.runOnce()).toBe(false);
		advance(1000);
		expect(await w.runOnce()).toBe(true);
		expect((await row("flaky")).attempts).toBe(2);
		expect(JSON.stringify(logs.lines)).not.toContain("customer words");
		processor = async () => {
			throw new Error("some message with customer words");
		};
		advance(10_000);
		await w.runOnce();
		expect((await row("flaky")).last_error_code).toBe("handler_error");
		expect(JSON.stringify(await sql`SELECT * FROM line_inbox`)).not.toContain(
			"some message",
		);
	});

	test("after the twelfth failure the event is dead, its payload gone, and the chat goes on", async () => {
		await store(
			messageEvent({ id: "poison", timestamp: 1000 }),
			messageEvent({ id: "fine", timestamp: 2000 }),
		);
		processor = async (event) => {
			if (event.id === "poison") throw new LineError("always_fails", "no");
			handled.push(event);
			return undefined;
		};
		const w = worker({ backoffBaseMs: 10, backoffCapMs: 10 });
		for (let i = 0; i < 12; i++) {
			await w.runOnce();
			advance(60_000);
		}
		expect(await row("poison")).toMatchObject({
			status: "dead",
			attempts: 12,
			payload: null,
			last_error_code: "always_fails",
		});
		await w.runOnce();
		expect(handled.map((e) => e.id)).toEqual(["fine"]);
		expect(
			logs.lines.some((l) => l.level === "error" && l.message.includes("dead")),
		).toBe(true);
	});

	test("an event whose lease ran out goes back to waiting, and one that keeps crashing ends dead", async () => {
		await store(
			messageEvent({ id: "crashed" }),
			messageEvent({ id: "doomed", timestamp: 5 }),
		);
		await sql`UPDATE line_inbox SET status = 'processing', attempts = 1, claimed_at = ${time}
			WHERE webhook_event_id = 'crashed'`;
		await sql`UPDATE line_inbox SET status = 'processing', attempts = 12, claimed_at = ${time}
			WHERE webhook_event_id = 'doomed'`;
		const w = worker({ leaseMs: 120_000 });
		advance(60_000);
		expect(await w.recoverLeases()).toBe(0);
		advance(61_000);
		expect(await w.recoverLeases()).toBe(2);
		expect(await row("crashed")).toMatchObject({
			status: "pending",
			last_error_code: "lease_expired",
			claimed_at: null,
		});
		expect(await row("doomed")).toMatchObject({
			status: "dead",
			payload: null,
		});
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["crashed"]);
		expect((await row("crashed")).attempts).toBe(2);
	});

	test("starting the worker recovers leases before it claims anything", async () => {
		await store(messageEvent({ id: "crashed" }));
		await sql`UPDATE line_inbox SET status = 'processing', attempts = 1, claimed_at = ${new Date(time.getTime() - 600_000)}
			WHERE webhook_event_id = 'crashed'`;
		const w = worker();
		await w.start();
		for (let i = 0; i < 400 && handled.length === 0; i++) await Bun.sleep(10);
		await w.stop();
		expect(handled.map((e) => e.id)).toEqual(["crashed"]);
	});

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
			requeues: 1,
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

	test("a processor asking for later is not a failure, up to a limit", async () => {
		await store(messageEvent({ id: "later" }));
		processor = async () => ({ retryInMs: 1000 });
		const w = worker({ maxRequeues: 3 });
		for (let i = 0; i < 3; i++) {
			expect(await w.runOnce()).toBe(true);
			advance(1000);
		}
		expect(await row("later")).toMatchObject({
			status: "pending",
			attempts: 0,
			requeues: 3,
		});
		expect(await w.runOnce()).toBe(true);
		expect(await row("later")).toMatchObject({
			status: "dead",
			last_error_code: "requeue_limit",
		});
	});

	test("a join of an unknown chat reaches the processor; a leave marks the chat left and a rejoin makes it pending again", async () => {
		const join = (id: string, type: string, timestamp: number) => ({
			...messageEvent({ id, timestamp, type }),
			message: undefined,
		});
		await receive(join("j1", "join", 100));
		const w = worker();
		await w.runOnce();
		expect(handled.map((e) => e.type)).toEqual(["join"]);
		expect((await sources().get(GROUP))?.status).toBe("pending");
		await sources().allow(GROUP);
		await receive(join("l1", "leave", 200));
		await w.runOnce();
		expect((await sources().get(GROUP))?.status).toBe("left");
		await receive(join("j2", "join", 300));
		await w.runOnce();
		expect((await sources().get(GROUP))?.status).toBe("pending");
		expect(handled.map((e) => e.id)).toEqual(["j1", "l1", "j2"]);
	});

	test("the loop handles events as they are stored, kicks wake it, and stop waits for work in hand", async () => {
		await store(messageEvent({ id: "one" }));
		const w = worker({ pollMs: 5000 });
		await w.start();
		for (let i = 0; i < 400 && handled.length < 1; i++) await Bun.sleep(10);
		expect(handled.map((e) => e.id)).toEqual(["one"]);
		// The poll is 5 s, so only the kick can explain the quick pickup.
		await receive(messageEvent({ id: "two", timestamp: 1_700_000_000_500 }));
		w.kick();
		for (let i = 0; i < 400 && handled.length < 2; i++) await Bun.sleep(10);
		expect(handled.map((e) => e.id)).toEqual(["one", "two"]);

		let release: () => void = () => undefined;
		processor = async (event) => {
			handled.push(event);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return undefined;
		};
		await receive(messageEvent({ id: "slow", timestamp: 1_700_000_001_000 }));
		w.kick();
		for (let i = 0; i < 400 && w.busy().length === 0; i++) await Bun.sleep(10);
		expect(w.busy()).toEqual(["slow"]);
		let stopped = false;
		const stopping = w.stop().then(() => {
			stopped = true;
		});
		await Bun.sleep(50);
		expect(stopped).toBe(false);
		release();
		await stopping;
		expect(w.busy()).toEqual([]);
		expect((await row("slow")).status).toBe("done");
	});
});
