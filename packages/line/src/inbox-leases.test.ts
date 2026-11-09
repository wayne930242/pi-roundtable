import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { LineError } from "./errors.ts";
import { InboxWorker } from "./inbox.ts";
import {
	advance,
	handled,
	logs,
	receive,
	row,
	START,
	sources,
	sql,
	state,
	store,
	time,
	until,
	useInboxHarness,
	worker,
} from "./testing/inbox-fixture.ts";
import { messageEvent } from "./testing/line-fake.ts";

describeDb("the inbox worker: leases and handlers", () => {
	useInboxHarness();

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

	test("R4REV-F003: a slow handler keeps its lease by heartbeat, and a worker recovering leases does not take its event", async () => {
		await store(messageEvent({ id: "slow" }));
		const gate = Promise.withResolvers<void>();
		state.processor = async (event) => {
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
		state.processor = async (event) => {
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
		state.processor = async (event) => {
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
		state.processor = async (event) => {
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
		state.processor = async (event, signal) => {
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
		state.processor = async (event) => {
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
		state.processor = async (event) => {
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
		handled.length = 0;
		await receive(messageEvent({ id: "a2", timestamp: 1000 }));
		const gate2 = Promise.withResolvers<void>();
		state.processor = async (event) => {
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
		state.processor = async (event) => {
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

	test("N-F002: an event claimed just as the processor was detached goes back uncounted, and nothing is handed to the old processor", async () => {
		await store(messageEvent({ id: "m1" }));
		let looks = 0;
		const processorLooks = () => (++looks === 2 ? undefined : state.processor);
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

	test("RR3-F001: a processor detached while a claimed event waited on its checks gets nothing", async () => {
		await store(messageEvent({ id: "m1" }));
		let looks = 0;
		// Before the claim, after it, and just before the call: detached by the third look.
		const processorLooks = () => (++looks >= 3 ? undefined : state.processor);
		const w = new InboxWorker({
			sql,
			logger: logs.logger,
			now: () => time,
			sources: sources(),
			processor: processorLooks,
			random: () => 1,
			options: { pollMs: 20 },
		});
		expect(await w.runOnce()).toBe(true);
		expect(handled).toEqual([]);
		expect(await row("m1")).toMatchObject({
			status: "pending",
			attempts: 0,
			requeues: 0,
			last_error_code: "no_processor",
		});
		expect((await row("m1")).payload).not.toBeNull();
	});

	test("RR3-nit: an error of its own a handler throws while the worker stops still counts", async () => {
		await store(messageEvent({ id: "m1" }));
		state.processor = async (event, signal) => {
			handled.push(event);
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve());
			});
			throw Object.assign(new Error("down"), { code: "discord_down" });
		};
		const w = worker({ maxHandleMs: 600_000 });
		await w.start();
		await until(() => handled.length === 1);
		await w.stop();
		expect(await row("m1")).toMatchObject({
			status: "pending",
			last_error_code: "discord_down",
		});
	});

	test("N-F002: the loop does not hand a new event to a processor it replaced", async () => {
		await store(messageEvent({ id: "first" }));
		const w = worker({ pollMs: 5 });
		await w.start();
		await until(() => handled.length === 1);
		await until(() => w.busy().length === 0);
		const replaced: string[] = [];
		state.processor = async (event) => {
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
		state.processor = async (event, signal) => {
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
		state.processor = async (event, signal) => {
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
		state.processor = async (event) => {
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
