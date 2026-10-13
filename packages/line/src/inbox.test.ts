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
		// Both are done and the loop is looking at an empty inbox before the processor is swapped.
		await until(() => w.busy().length === 0);

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
		await until(() => w.busy().join() === "slow");
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

	/** An `unsend` of `messageId`. */
	const unsendOf = (id: string, messageId: string, timestamp: number) => ({
		...messageEvent({ id, timestamp, type: "unsend" }),
		message: undefined,
		unsend: { messageId },
	});
	/** A `messageEdited` of `messageId`. */
	const editOf = (id: string, messageId: string, timestamp: number) =>
		messageEvent({ id, timestamp, type: "messageEdited", messageId });
	/** Lets the next `handled` entry appear, for a handler that runs in the background. */
	const until = async (done: () => boolean) => {
		for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(10);
		expect(done()).toBe(true);
	};

	test("R4REV-F001: an unsend waits for an original that keeps failing, however long, and never dies before it settles", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
		);
		let tries = 0;
		processor = async (event) => {
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
		processor = async (event) => {
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

	test("R4REV-F002: after block() an event that fails or asks for later is not handed out again, and loses its payload", async () => {
		for (const outcome of ["throw", "later"] as const) {
			await sql`TRUNCATE line_inbox, line_sources`;
			handled = [];
			await store(messageEvent({ id: "m1", text: "customer words" }));
			processor = async (event) => {
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
		processor = async (event) => {
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

	test("R4REV-F003: a slow handler keeps its lease by heartbeat, and a worker recovering leases does not take its event", async () => {
		await store(messageEvent({ id: "slow" }));
		const gate = Promise.withResolvers<void>();
		processor = async (event) => {
			handled.push(event);
			await gate.promise;
			return undefined;
		};
		const w = worker({ leaseMs: 900 });
		const running = w.runOnce();
		await until(() => handled.length === 1);
		// Time passes by the clock the lease is read with; the heartbeat runs in real time.
		advance(800);
		for (
			let i = 0;
			i < 400 &&
			new Date((await row("slow")).claimed_at).getTime() === START.getTime();
			i++
		)
			await Bun.sleep(10);
		advance(800);
		expect(await w.recoverLeases()).toBe(0);
		// Another process (its own clock and no knowledge of this one's handlers) sees a live lease too.
		expect(await worker({ leaseMs: 900 }).recoverLeases()).toBe(0);
		expect(await w.runOnce()).toBe(false);
		gate.resolve();
		await running;
		expect(handled.length).toBe(1);
		expect(await row("slow")).toMatchObject({ status: "done", attempts: 1 });
	});

	test("R4REV-F003: a worker never reclaims its own live event, even past the lease", async () => {
		await store(messageEvent({ id: "slow" }));
		const gate = Promise.withResolvers<void>();
		processor = async (event) => {
			handled.push(event);
			await gate.promise;
			return undefined;
		};
		const w = worker({ leaseMs: 100_000 });
		const running = w.runOnce();
		await until(() => handled.length === 1);
		advance(500_000);
		expect(await w.recoverLeases()).toBe(0);
		expect(await w.runOnce()).toBe(false);
		// A worker of another process cannot know it, so it does.
		expect(await worker({ leaseMs: 100_000 }).recoverLeases()).toBe(1);
		gate.resolve();
		await running;
	});

	test("R4REV-F003: a handler that lost its lease cannot reopen what the next claim finished", async () => {
		await store(messageEvent({ id: "m1" }));
		const failLate = Promise.withResolvers<void>();
		processor = async (event) => {
			handled.push(event);
			if (event.attempt === 1) {
				await failLate.promise;
				throw new LineError("late_failure", "no");
			}
			return undefined;
		};
		const a = worker().runOnce();
		await until(() => handled.length === 1);
		// The lease was lost (another process recovered it) and a second worker handles the event.
		await sql`UPDATE line_inbox SET status = 'pending', claimed_at = NULL WHERE webhook_event_id = 'm1'`;
		advance(1);
		await worker().runOnce();
		expect(await row("m1")).toMatchObject({ status: "done", payload: null });
		// The late failure of the first handler is dropped instead of putting the event back.
		failLate.resolve();
		await a;
		expect(await row("m1")).toMatchObject({
			status: "done",
			payload: null,
			attempts: 2,
		});
		expect(handled.map((e) => e.attempt)).toEqual([1, 2]);
	});

	test("R4REV-F003: a handler that finishes after its lease was lost leaves the next claim alone", async () => {
		await store(messageEvent({ id: "m1" }));
		const gates = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		];
		processor = async (event) => {
			handled.push(event);
			await gates[event.attempt - 1]?.promise;
			return undefined;
		};
		const a = worker().runOnce();
		await until(() => handled.length === 1);
		await sql`UPDATE line_inbox SET status = 'pending', claimed_at = NULL WHERE webhook_event_id = 'm1'`;
		advance(1);
		const b = worker().runOnce();
		await until(() => handled.length === 2);
		gates[0]?.resolve();
		await a;
		expect(await row("m1")).toMatchObject({
			status: "processing",
			attempts: 2,
		});
		expect((await row("m1")).payload).not.toBeNull();
		gates[1]?.resolve();
		await b;
		expect(await row("m1")).toMatchObject({ status: "done" });
	});

	test("R4REV-F004: edits of one message run in order even when the earlier one is backing off, while other messages go on", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			editOf("e1", "M1", 2000),
			messageEvent({ id: "other", timestamp: 2500, messageId: "M2" }),
			editOf("e2", "M1", 3000),
		);
		let failed = false;
		processor = async (event) => {
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

	test("R4RR-F001: a handler that never settles fails with handler_timeout, its chat goes on, and its late settle changes nothing", async () => {
		await store(
			messageEvent({ id: "a1", timestamp: 1000 }),
			messageEvent({ id: "a2", timestamp: 2000 }),
		);
		const gates = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		];
		let aborted = false;
		processor = async (event, signal) => {
			handled.push(event);
			if (event.id === "a1") {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				await gates[event.attempt - 1]?.promise;
				return { retryInMs: 1 };
			}
			return undefined;
		};
		const w = worker({
			maxHandleMs: 300,
			leaseMs: 60_000,
			backoffBaseMs: 1000,
		});
		const started = Date.now();
		expect(await w.runOnce()).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(aborted).toBe(true);
		expect(await row("a1")).toMatchObject({
			status: "pending",
			attempts: 1,
			last_error_code: "handler_timeout",
		});
		// The chat is not held by the stuck event: the next one is handed out.
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => e.id)).toEqual(["a1", "a2"]);
		// a1 comes back, attempt 2 is in hand; then the first handler finally settles.
		advance(2000);
		const second = w.runOnce();
		await until(() => handled.length === 3);
		gates[0]?.resolve();
		await Bun.sleep(50);
		expect(await row("a1")).toMatchObject({
			status: "processing",
			attempts: 2,
			requeues: 0,
		});
		expect((await row("a1")).payload).not.toBeNull();
		gates[1]?.resolve();
		await second;
		// Attempt 2 asked to look again later, which is its own outcome, not the first handler's.
		expect(await row("a1")).toMatchObject({ status: "pending", requeues: 1 });
	});

	test("R4RR-F001: a handler that never settles does not keep the worker from stopping or the heartbeat from ending", async () => {
		await store(messageEvent({ id: "stuck" }));
		processor = async (event) => {
			handled.push(event);
			return new Promise<never>(() => undefined);
		};
		const w = worker({ maxHandleMs: 150, leaseMs: 300 });
		await w.start();
		await until(() => handled.length === 1);
		const stopped = await Promise.race([
			w.stop().then(() => "stopped"),
			Bun.sleep(3000).then(() => "hung"),
		]);
		expect(stopped).toBe("stopped");
		expect(w.busy()).toEqual([]);
		expect(await row("stuck")).toMatchObject({
			status: "pending",
			last_error_code: "handler_timeout",
		});
	});

	test("R4RR-F002: while a handler is stuck a kick hands another chat's new event out at once, and a poll does too", async () => {
		await store(messageEvent({ id: "a1", timestamp: 1000 }));
		const gate = Promise.withResolvers<void>();
		processor = async (event) => {
			handled.push(event);
			if (event.id === "a1") await gate.promise;
			return undefined;
		};
		const w = worker({ concurrency: 2, pollMs: 60_000, maxHandleMs: 600_000 });
		await w.start();
		await until(() => handled.length === 1);
		await receive(messageEvent({ id: "b1", group: "Cgroup0002" }));
		w.kick();
		await until(() => handled.some((e) => e.id === "b1"));
		// b1 is done once only a1 is still in hand.
		await until(() => w.busy().join() === "a1");
		expect(await row("b1")).toMatchObject({ status: "done" });
		gate.resolve();
		await w.stop();

		// Without a kick the poll finds it.
		await sql`TRUNCATE line_inbox`;
		handled = [];
		await receive(messageEvent({ id: "a2", timestamp: 1000 }));
		const gate2 = Promise.withResolvers<void>();
		processor = async (event) => {
			handled.push(event);
			if (event.id === "a2") await gate2.promise;
			return undefined;
		};
		const polled = worker({ concurrency: 2, pollMs: 30, maxHandleMs: 600_000 });
		await polled.start();
		await until(() => handled.length === 1);
		await receive(messageEvent({ id: "b2", group: "Cgroup0002" }));
		await until(() => handled.some((e) => e.id === "b2"));
		gate2.resolve();
		await polled.stop();
	});

	test("R4RR-F002: a free slot is refilled when a handler ends, and expired leases are still put back while one handler is stuck", async () => {
		await store(
			messageEvent({ id: "a1", timestamp: 1000 }),
			messageEvent({ id: "x1", timestamp: 1000, group: "Cgroup0002" }),
		);
		// x1 was claimed by a process that died.
		await sql`UPDATE line_inbox SET status = 'processing', claimed_at = ${START}, attempts = 1 WHERE webhook_event_id = 'x1'`;
		const gate = Promise.withResolvers<void>();
		processor = async (event) => {
			handled.push(event);
			if (event.id === "a1") await gate.promise;
			return undefined;
		};
		const w = worker({
			concurrency: 2,
			leaseMs: 200,
			pollMs: 20,
			maxHandleMs: 600_000,
		});
		await w.start();
		await until(() => handled.some((e) => e.id === "a1"));
		advance(1000);
		await until(() => handled.some((e) => e.id === "x1"));
		await until(() => w.busy().join() === "a1");
		expect(await row("x1")).toMatchObject({ status: "done", attempts: 2 });
		gate.resolve();
		await w.stop();
	});

	test("R4RR-nit: an event waiting for a message that is backing off is looked at again when that message is due, not every few seconds", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
		);
		processor = async (event) => {
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

	const membership = (id: string, type: string, timestamp: number) => ({
		...messageEvent({ id, timestamp, type }),
		message: undefined,
	});

	test("N-F001: an unsend backing off when the bot leaves is still delivered (N1a)", async () => {
		await store(
			messageEvent({ id: "m1", timestamp: 1000, messageId: "M1" }),
			unsendOf("u1", "M1", 2000),
		);
		let failed = false;
		processor = async (event) => {
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
		processor = async (event) => {
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

	test("N-F002: an event claimed just as the processor was detached goes back uncounted, and nothing is handed to the old processor", async () => {
		await store(messageEvent({ id: "m1" }));
		let looks = 0;
		const processorLooks = () => (++looks === 2 ? undefined : processor);
		const w = new InboxWorker({
			sql,
			logger: logs.logger,
			now: () => time,
			sources: sources(),
			// The first look is the one before the claim; the second is the one after it.
			processor: processorLooks,
			random: () => 1,
			options: { pollMs: 20 },
		});
		expect(await w.runOnce()).toBe(false);
		expect(handled).toEqual([]);
		expect(await row("m1")).toMatchObject({
			status: "pending",
			attempts: 0,
			requeues: 0,
			last_error_code: "no_processor",
		});
		expect((await row("m1")).payload).not.toBeNull();
		// Once it is due again and a processor is attached it is handled as attempt 1.
		advance(20);
		expect(await w.runOnce()).toBe(true);
		expect(handled.map((e) => [e.id, e.attempt])).toEqual([["m1", 1]]);
	});

	test("N-F002: the loop does not hand a new event to a processor it replaced", async () => {
		await store(messageEvent({ id: "first" }));
		const w = worker({ pollMs: 5 });
		await w.start();
		await until(() => handled.length === 1);
		await until(() => w.busy().length === 0);
		const replaced: string[] = [];
		processor = async (event) => {
			replaced.push(event.id);
			return undefined;
		};
		await receive(messageEvent({ id: "second", timestamp: 1_700_000_000_500 }));
		w.kick();
		await until(() => replaced.length === 1);
		await w.stop();
		expect(handled.map((e) => e.id)).toEqual(["first"]);
		expect(replaced).toEqual(["second"]);
	});

	test("N-nit: stop() aborts the signal of a handler in hand, and the event goes back without a failure", async () => {
		await store(messageEvent({ id: "slow" }));
		let reason: unknown;
		processor = async (event, signal) => {
			handled.push(event);
			await new Promise<void>((_, reject) => {
				const giveUp = () => {
					reason = signal.reason;
					reject(signal.reason);
				};
				if (signal.aborted) giveUp();
				else signal.addEventListener("abort", giveUp);
			});
			return undefined;
		};
		const w = worker({ maxHandleMs: 600_000 });
		await w.start();
		await until(() => handled.length === 1);
		const started = Date.now();
		await w.stop();
		expect(Date.now() - started).toBeLessThan(2000);
		expect(reason).toMatchObject({ code: "worker_stopped" });
		// The requeued event was not handed out again while the worker was stopping.
		expect(handled.length).toBe(1);
		expect(w.busy()).toEqual([]);
		expect(await row("slow")).toMatchObject({
			status: "pending",
			attempts: 0,
			requeues: 0,
			last_error_code: "worker_stopped",
		});
		expect((await row("slow")).payload).not.toBeNull();
	});

	test("N-nit: a stopped worker hands nothing out, and an event it claims as it stops goes back uncounted", async () => {
		await store(messageEvent({ id: "m1" }));
		const w = worker();
		await w.start();
		await w.stop();
		expect(await w.runOnce()).toBe(false);
		expect(handled).toEqual([]);
		expect(await row("m1")).toMatchObject({
			status: "pending",
			attempts: 0,
			requeues: 0,
			last_error_code: "worker_stopped",
		});
		// Started again, it is handled as the first attempt.
		await w.start();
		await until(() => handled.length === 1);
		await w.stop();
		expect(handled.map((e) => [e.id, e.attempt])).toEqual([["m1", 1]]);
	});

	test("N-nit: a heartbeat that finds the lease gone aborts the signal of the handler", async () => {
		await store(messageEvent({ id: "m1" }));
		const gate = Promise.withResolvers<unknown>();
		processor = async (event, signal) => {
			handled.push(event);
			if (signal.aborted) gate.resolve(signal.reason);
			else signal.addEventListener("abort", () => gate.resolve(signal.reason));
			return gate.promise.then(() => undefined);
		};
		const running = worker({ leaseMs: 300, maxHandleMs: 600_000 }).runOnce();
		await until(() => handled.length === 1);
		// Another process recovered the event.
		await sql`UPDATE line_inbox SET status = 'pending', claimed_at = NULL WHERE webhook_event_id = 'm1'`;
		expect(await gate.promise).toMatchObject({ code: "lease_lost" });
		await running;
		expect(await row("m1")).toMatchObject({ status: "pending" });
	});

	test("N-F003: a handler that ignores its signal is still running when the chat's next event is handed out", async () => {
		await store(
			messageEvent({ id: "a1", timestamp: 1000 }),
			messageEvent({ id: "a2", timestamp: 2000 }),
		);
		let live = 0;
		let maxLive = 0;
		processor = async (event) => {
			handled.push(event);
			live++;
			maxLive = Math.max(maxLive, live);
			if (event.id === "a1") await Bun.sleep(400);
			live--;
			return undefined;
		};
		const w = worker({ maxHandleMs: 100, leaseMs: 60_000 });
		expect(await w.runOnce()).toBe(true);
		expect(await w.runOnce()).toBe(true);
		// This is what the README documents: the abandoned handler overlaps the chat's next event.
		expect(maxLive).toBe(2);
		await Bun.sleep(450);
	});
});
