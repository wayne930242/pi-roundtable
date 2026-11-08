import { afterEach, describe, expect, test } from "bun:test";
import { HostStoppingError } from "../kernel/errors.ts";
import { silentLogger } from "../kernel/log.ts";
import type { RoundtablePlugin, Service } from "../plugin-api/plugin.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";

const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
});

function host(
	plugins: RoundtablePlugin[],
	options: Partial<RoundtableOptions> = {},
): Roundtable {
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50, abortGraceMs: 20 },
			...options,
		},
		plugins,
	);
	hosts.push(roundtable);
	return roundtable;
}

function plugin(name: string, services: Service[]): RoundtablePlugin {
	return { name, setup: () => ({ services }) };
}

describe("a service told to stop its work at the drain limit", () => {
	test("hears abort before stop, and is given the abort grace in between", async () => {
		const log: string[] = [];
		let busy = ["job"];
		const roundtable = host([
			plugin("desk", [
				{
					name: "desk",
					busy: () => busy,
					abort: () => {
						log.push("abort");
						// Work told to stop ends within the grace.
						setTimeout(() => {
							busy = [];
							log.push("ended");
						}, 5);
						return true;
					},
					stop: () => void log.push("stop"),
				},
			]),
		]);
		await roundtable.run();
		await roundtable.shutdown("SIGTERM");
		expect(log).toEqual(["abort", "ended", "stop"]);
	});

	test("is not told when it has nothing busy, and a failing abort does not stop the shutdown", async () => {
		const log: string[] = [];
		const roundtable = host([
			plugin("idle", [
				{
					name: "idle",
					busy: () => [],
					abort: () => {
						log.push("idle abort");
						return true;
					},
				},
			]),
			plugin("broken", [
				{
					name: "broken",
					busy: () => ["job"],
					abort: () => {
						throw new Error("no signal");
					},
					stop: () => void log.push("broken stop"),
				},
			]),
		]);
		await roundtable.run();
		expect(await roundtable.shutdown("SIGTERM")).toBe(0);
		expect(log).toEqual(["broken stop"]);
	});
});

/** A host with a service that finishes work after the close, delivering it through the queue. */
function reporting(options: Partial<RoundtableOptions> = {}) {
	const log: string[] = [];
	let finishing: (() => Promise<unknown>) | undefined;
	let busy = ["fake:room"];
	const roundtable = host(
		[
			{
				name: "fake",
				setup: (context) => {
					finishing = () =>
						context.queue.finishing(() =>
							context.queue.run("fake:room", async () => {
								log.push(`report, closed ${context.queue.closed}`);
								return "reported";
							}),
						);
					return {
						services: [
							{
								name: "desk",
								busy: () => busy,
								stop: () => void log.push("stop"),
							},
						],
					};
				},
			},
		],
		options,
	);
	return {
		roundtable,
		log,
		finish: async () => {
			const outcome = await finishing?.().catch((error: unknown) => error);
			busy = [];
			return outcome;
		},
	};
}

describe("work that ends during the drain", () => {
	test("delivers its report through the queue although the host is shutting down", async () => {
		const s = reporting({ drain: { intervalMs: 1, limitMs: 2_000 } });
		await s.roundtable.run();
		const stopped = s.roundtable.shutdown("SIGTERM");
		await Bun.sleep(10);
		const outcome = await s.finish();
		expect(await stopped).toBe(0);
		expect(outcome).toBe("reported");
		expect(s.log).toEqual(["report, closed false", "stop"]);
	});

	test("a report that arrives after the drain ended is refused", async () => {
		const s = reporting({
			drain: { intervalMs: 1, limitMs: 20, abortGraceMs: 5 },
		});
		await s.roundtable.run();
		await s.roundtable.shutdown("SIGTERM");
		expect(await s.finish()).toBeInstanceOf(HostStoppingError);
		expect(s.log).toEqual(["stop"]);
	});
});
