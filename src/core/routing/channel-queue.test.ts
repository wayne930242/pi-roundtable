import { describe, expect, test } from "bun:test";
import { HostStoppingError } from "../kernel/errors.ts";
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

	test("a task started inside finishing() is still admitted once the queue is closed, until it is sealed", async () => {
		const queue = new ChannelQueue();
		queue.close();
		const seen: boolean[] = [];
		const ran = await queue.finishing(async () => {
			seen.push(queue.closed);
			return queue.run("discord:1", async () => {
				// What the admitted task awaits is admitted too: the report turn checks `closed` itself.
				await Bun.sleep(0);
				seen.push(queue.closed);
				return "report";
			});
		});
		expect(ran).toBe("report");
		expect(seen).toEqual([false, false]);
		// Outside the scope the queue is still closed, and ordinary tasks are refused.
		expect(queue.closed).toBe(true);
		await expect(queue.run("discord:1", async () => 1)).rejects.toBeInstanceOf(
			HostStoppingError,
		);
		queue.seal();
		await expect(
			queue.finishing(() => queue.run("discord:1", async () => 1)),
		).rejects.toBeInstanceOf(HostStoppingError);
		await queue.finishing(async () => void seen.push(queue.closed));
		expect(seen.at(-1)).toBe(true);
	});

	test("a task admitted by finishing() that waits behind a running one still starts after the close", async () => {
		const queue = new ChannelQueue();
		let release = () => {};
		const running = queue.run(
			"discord:1",
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		await Bun.sleep(0);
		const report = queue.finishing(() =>
			queue.run("discord:1", async () => "report"),
		);
		queue.close();
		release();
		await running;
		expect(await report).toBe("report");
	});
});
