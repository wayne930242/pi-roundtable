import { describe, expect, test } from "bun:test";
import { ChannelQueue } from "./channel-queue.ts";

describe("ChannelQueue", () => {
	test("reports every change of a channel's count", async () => {
		const queue = new ChannelQueue();
		const seen: [string, number][] = [];
		queue.onChange((channel) => seen.push([channel, queue.size(channel)]));
		let release = () => {};
		const first = queue.run(
			"discord:1",
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		const second = queue.run("discord:1", async () => {});
		expect(seen).toEqual([
			["discord:1", 1],
			["discord:1", 2],
		]);
		// The first task starts on a later tick.
		await Bun.sleep(0);
		release();
		await Promise.all([first, second]);
		await Bun.sleep(0);
		expect(seen).toEqual([
			["discord:1", 1],
			["discord:1", 2],
			["discord:1", 1],
			["discord:1", 0],
		]);
	});
});
