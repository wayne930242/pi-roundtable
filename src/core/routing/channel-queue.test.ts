import { describe, expect, test } from "bun:test";
import { HostStoppingError } from "../errors.ts";
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

	test("a closed queue refuses new tasks, and tasks waiting that have not started, but lets the running one finish", async () => {
		const queue = new ChannelQueue();
		const ran: string[] = [];
		let release = () => {};
		const running = queue.run("discord:1", async () => {
			await new Promise<void>((resolve) => (release = resolve));
			ran.push("running");
		});
		const waiting = queue.run(
			"discord:1",
			async () => void ran.push("waiting"),
		);
		const waitingResult = waiting.catch((error: unknown) => error);
		await Bun.sleep(0);
		expect(queue.closed).toBe(false);
		queue.close();
		expect(queue.closed).toBe(true);
		const late = queue
			.run("discord:2", async () => void ran.push("late"))
			.catch((error: unknown) => error);
		release();
		await running;
		expect(await waitingResult).toBeInstanceOf(HostStoppingError);
		expect(await late).toBeInstanceOf(HostStoppingError);
		await Bun.sleep(0);
		expect(ran).toEqual(["running"]);
		expect(queue.busy()).toEqual([]);
	});
});
