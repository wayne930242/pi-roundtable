import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { GROUP, SECRET } from "./testing/line-fake.ts";
import {
	build,
	ctl,
	drain,
	fake,
	logs,
	outbox,
	results,
	rows,
	SENDER,
	text,
	useOutboxHarness,
	worker,
} from "./testing/outbox-fixture.ts";

describeDb("the outbox: results, logs and stop", () => {
	useOutboxHarness();

	test("results wait while nobody listens, and a subscriber that fails is told again later", async () => {
		await outbox.enqueue(GROUP, [text("hi")], { origin: "x" });
		ctl.clock = 2_000;
		await drain();
		ctl.hearing = false;
		expect(await worker.notify()).toBe(0);
		expect((await rows())[0]?.notified_at).toBeNull();
		ctl.hearing = true;
		expect(await worker.notify()).toBe(1);
		expect(results).toHaveLength(1);

		await outbox.enqueue(GROUP, [text("again")], { origin: "y" });
		ctl.clock += 2_000;
		await drain();
		ctl.emitError = new Error("subscriber broke");
		expect(await worker.notify()).toBe(0);
		expect((await rows())[1]).toMatchObject({
			notify_attempts: 1,
			notified_at: null,
		});
		expect(results).toHaveLength(1);
		ctl.emitError = undefined;
		// Not told again before its backoff is over; then the working worker tells it.
		expect(await worker.notify()).toBe(0);
		ctl.clock += 3_600_000;
		expect(await worker.notify()).toBe(1);
		expect(results.at(-1)).toMatchObject({ originRef: "y", status: "sent" });
	});

	test("the message text, the access token and the retry key appear in no log line", async () => {
		await outbox.enqueue(GROUP, [text("PRIVATE-WORDS")], { sender: SENDER });
		const [row] = await rows();
		ctl.clock = 2_000;
		fake.pushScript.push(500, {
			status: 400,
			body: { message: "PRIVATE-WORDS echoed", details: [] },
		});
		await worker.runOnce();
		ctl.clock += 5_000;
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
			ctl.clock += 10;
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
			{ status: "queued", attempts: 1, last_error_code: "worker_stopped" },
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
		// The loop tells the subscriber too, and the request the stop cut short was a try.
		expect(results).toHaveLength(1);
		expect(results[0]?.attempts).toBe(2);
	});

	test("a stop before the request gives the attempt back, also after an earlier try; a stop after the request keeps it", async () => {
		await outbox.enqueue(GROUP, [text("hi")]);
		ctl.clock = 2_000;
		fake.pushScript.push(500);
		await worker.runOnce();
		expect(await rows()).toMatchObject([{ status: "queued", attempts: 1 }]);
		expect((await rows())[0]?.requested_at).not.toBeNull();
		ctl.clock += 3_600_000;
		// Stopped before the request is made: nothing reaches LINE and the count is what it was.
		await worker.stop();
		await worker.runOnce();
		expect(fake.pushes).toHaveLength(1);
		expect(await rows()).toMatchObject([
			{ status: "queued", attempts: 1, last_error_code: "worker_stopped" },
		]);
		expect((await rows())[0]?.requested_at).toBeNull();
		// Stopped with the request out: it may have reached LINE, so it stays counted.
		build();
		fake.pushDelayMs = 200;
		const inFlight = worker.runOnce();
		for (
			let i = 0;
			i < 100 && fake.calls.filter((c) => c.url.endsWith("/push")).length < 2;
			i++
		)
			await Bun.sleep(10);
		await worker.stop();
		await inFlight;
		expect(await rows()).toMatchObject([
			{ status: "queued", attempts: 2, last_error_code: "worker_stopped" },
		]);
		expect((await rows())[0]?.requested_at).not.toBeNull();
		// The next claim starts a clean attempt, which a stop before its request gives back.
		build();
		fake.pushDelayMs = 0;
		await worker.stop();
		await worker.runOnce();
		expect(await rows()).toMatchObject([{ status: "queued", attempts: 2 }]);
		expect((await rows())[0]?.requested_at).toBeNull();
	});
});
