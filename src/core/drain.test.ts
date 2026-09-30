import { describe, expect, test } from "bun:test";
import { waitUntilIdle } from "./drain.ts";
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
