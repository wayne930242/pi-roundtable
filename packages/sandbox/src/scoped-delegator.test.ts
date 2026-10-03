import { expect, test } from "bun:test";
import type { DelegationJob } from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import { ScopedSandboxDelegator } from "./scoped-delegator.ts";

test("delegation fixes target, channel and speaker/report while refusing owner dispatch fields", async () => {
	const reports: DelegationJob[] = [];
	const contexts: unknown[] = [];
	const scoped = new ScopedSandboxDelegator({
		target: "guest",
		run: async (_task, context) => {
			contexts.push(context);
			return "report";
		},
		deliver: async (job) => {
			reports.push(job);
		},
		logger: silentLogger(),
	});
	const request = {
		channel: "discord:channel" as const,
		target: "guest",
		author: { id: "speaker", name: "Guest" },
		title: "Research",
		task: "Check a public source",
	};
	for (const invalid of [
		{ ...request, target: "owner" },
		{ ...request, origin: "discord:owner" as const },
		{ ...request, author: { ...request.author, tier: "owner" as const } },
	])
		expect(() => scoped.start(invalid)).toThrow("scope");
	const job = scoped.start(request);
	await scoped.idle();
	expect(reports).toEqual([job]);
	expect(contexts).toEqual([
		expect.objectContaining({
			channel: "discord:channel",
			author: { id: "speaker", name: "Guest" },
		}),
	]);
	await scoped.dispose();
});
test("channel job limits, task bounds and shutdown cancellation are enforced", async () => {
	let cancelled = 0;
	const scoped = new ScopedSandboxDelegator({
		target: "guest",
		maxRunning: 1,
		run: async (_task, context) =>
			new Promise((_resolve, reject) => {
				context.signal.addEventListener(
					"abort",
					() => {
						cancelled++;
						reject(new Error("cancelled"));
					},
					{ once: true },
				);
			}),
		deliver: async () => {},
		logger: silentLogger(),
	});
	const request = {
		channel: "discord:channel" as const,
		target: "guest",
		author: { id: "speaker", name: "Guest" },
		title: "Research",
		task: "Check a public source",
	};
	expect(() => scoped.start({ ...request, task: "x".repeat(4001) })).toThrow();
	scoped.start(request);
	expect(() => scoped.start(request)).toThrow("too many");
	expect(scoped.runningChannels()).toEqual(["discord:channel"]);
	await scoped.dispose();
	expect(cancelled).toBe(1);
	expect(scoped.runningChannels()).toEqual([]);
	expect(() => scoped.start(request)).toThrow("scope");
});
