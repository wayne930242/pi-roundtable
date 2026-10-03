import { expect, test } from "bun:test";
import type { DelegationJob, DelegationOutcome } from "pi-roundtable";
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
	expect(() => scoped.start({ ...request, task: "x".repeat(4001) })).toThrow(
		"the task is 4001 characters; keep it within 4000",
	);
	expect(() => scoped.start({ ...request, title: " " })).toThrow(
		"title and task are required",
	);
	scoped.start(request);
	expect(() => scoped.start(request)).toThrow(
		"this channel already has 1 delegated tasks running; wait for one to report back",
	);
	expect(scoped.runningChannels()).toEqual(["discord:channel"]);
	await scoped.dispose();
	expect(cancelled).toBe(1);
	expect(scoped.runningChannels()).toEqual([]);
	expect(() => scoped.start(request)).toThrow("scope");
});

test("a failed run reports its scrubbed reason, and a deadline reads as running out of time", async () => {
	const outcomes: DelegationOutcome[] = [];
	let mode: "error" | "deadline" = "error";
	const scoped = new ScopedSandboxDelegator({
		target: "guest",
		timeoutMs: 1000,
		run: async (_task, context) => {
			if (mode === "error")
				throw new Error(
					"Request to https://user:hunter2@example.invalid failed: 429 rate limited",
				);
			return new Promise((_resolve, reject) =>
				context.signal.addEventListener("abort", () => reject(new Error("x"))),
			);
		},
		deliver: async (_job, outcome) => {
			outcomes.push(outcome);
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
	scoped.start(request);
	await scoped.idle();
	const failed = outcomes[0];
	expect(failed?.ok).toBe(false);
	if (failed && !failed.ok) {
		expect(failed.error).toContain("429 rate limited");
		expect(failed.error).not.toContain("hunter2");
	}
	mode = "deadline";
	scoped.start(request);
	await scoped.idle();
	expect(outcomes[1]).toEqual({
		ok: false,
		error: "the worker ran out of time",
	});
});
