import { describe, expect, test } from "bun:test";
import {
	DRAIN_LIMIT_MS,
	drainWork,
	stopTurns,
	waitUntilIdle,
} from "./drain.ts";
import { silentLogger } from "./log.ts";
import { ChannelQueue } from "./routing/channel-queue.ts";

describe("waitUntilIdle", () => {
	test("returns at once when nothing runs", async () => {
		expect(await waitUntilIdle({ busy: () => [] })).toEqual([]);
	});

	test("waits for queued work, including work that arrives while waiting", async () => {
		const queue = new ChannelQueue();
		const done: string[] = [];
		let release = () => {};
		void queue.run("discord:1", async () => {
			await new Promise<void>((r) => {
				release = r;
			});
			done.push("first");
		});
		const waiting = waitUntilIdle({ busy: () => queue.busy(), intervalMs: 5 });
		await Bun.sleep(20);
		void queue.run("discord:2", async () => {
			await Bun.sleep(30);
			done.push("second");
		});
		release();
		expect(await waiting).toEqual([]);
		expect(done).toEqual(["first", "second"]);
		expect(queue.busy()).toEqual([]);
	});

	test("gives up at the limit and says what is still busy", async () => {
		let clock = 0;
		const left = await waitUntilIdle({
			busy: () => ["discord:1", "discord:1"],
			limitMs: 3_000,
			intervalMs: 1_000,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(left).toEqual(["discord:1", "discord:1"]);
		expect(clock).toBe(3_000);
	});
});

function clock() {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
		at: () => now,
	};
}

describe("drainWork", () => {
	test("the default limit is three minutes", () => {
		expect(DRAIN_LIMIT_MS).toBe(180_000);
	});

	test("does not abort work that ends within the limit", async () => {
		const time = clock();
		let busy = ["discord:1"];
		const told: string[][] = [];
		const left = await drainWork({
			busy: () => busy,
			limitMs: 5_000,
			intervalMs: 1_000,
			now: time.now,
			sleep: async (ms) => {
				await time.sleep(ms);
				if (time.at() >= 2_000) busy = [];
			},
			abort: (work) => {
				told.push(work);
				return true;
			},
		});
		expect(left).toEqual([]);
		expect(told).toEqual([]);
	});

	test("aborts what the limit finds running, waits the grace for it to end, and hands the work over", async () => {
		const time = clock();
		let stoppedAt: number | undefined;
		const left = await drainWork({
			busy: () =>
				stoppedAt !== undefined && time.at() - stoppedAt >= 2_000
					? []
					: ["discord:1"],
			limitMs: 3_000,
			intervalMs: 1_000,
			abortGraceMs: 5_000,
			now: time.now,
			sleep: time.sleep,
			abort: () => {
				// The stopped turn ends two seconds later.
				stoppedAt = time.at();
				return true;
			},
		});
		expect(left).toEqual(["discord:1"]);
		expect(time.at()).toBe(5_000);
	});

	test("does not wait for work nothing could be told to stop", async () => {
		const time = clock();
		const left = await drainWork({
			busy: () => ["delegator"],
			limitMs: 3_000,
			intervalMs: 1_000,
			abortGraceMs: 60_000,
			now: time.now,
			sleep: time.sleep,
			abort: () => false,
		});
		expect(left).toEqual(["delegator"]);
		expect(time.at()).toBe(3_000);
	});
});

describe("stopTurns", () => {
	test("tells each channel once, survives a stop that throws, and says whether any turn was running", () => {
		const asked: string[] = [];
		const stopped = stopTurns(
			["discord:1", "discord:1", "discord:2", "discord:3"],
			(channel) => {
				asked.push(channel);
				if (channel === "discord:2") throw new Error("boom");
				return channel === "discord:3";
			},
			silentLogger(),
		);
		expect(asked).toEqual(["discord:1", "discord:2", "discord:3"]);
		expect(stopped).toBe(true);
		expect(stopTurns(["x:1"], () => false, silentLogger())).toBe(false);
	});
});
