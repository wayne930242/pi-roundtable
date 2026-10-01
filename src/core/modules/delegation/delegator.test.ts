import { describe, expect, test } from "bun:test";
import type { BackgroundTarget } from "../../contract/channels.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import { DelegationError } from "../../domain/errors.ts";
import { messages } from "../../i18n/index.ts";
import { silentLogger } from "../../log.ts";
import { fakeThreads } from "../../testing/thread-host.ts";
import {
	DefaultDelegator,
	type DelegationJob,
	type DelegationOutcome,
	delegatedTurnText,
} from "./delegator.ts";

const OWNER = { id: "1", name: "Riley" };

/** Sample targets: a roomy one, a tight one, and one that may not delegate. */
const TARGETS: readonly BackgroundTarget[] = [
	{ name: "main", label: () => "Main", delegation: { maxRunning: 3 } },
	{ name: "open", label: () => "Open", delegation: { maxRunning: 2 } },
	{ name: "closed", label: () => "Closed" },
];

function setup(
	run: (task: string, signal: AbortSignal) => Promise<string>,
	timeoutMs?: number,
) {
	const reports: [DelegationJob, DelegationOutcome][] = [];
	const { host, threads } = fakeThreads();
	/** Threads already archived when each report was delivered. */
	const archived: string[][] = [];
	const delegator = new DefaultDelegator({
		worker: { run },
		targets: (name) => TARGETS.find((target) => target.name === name),
		deliver: async (job, outcome) => {
			archived.push([...host.closed]);
			reports.push([job, outcome]);
		},
		threads,
		logger: silentLogger(),
		...(timeoutMs ? { timeoutMs } : {}),
	});
	return { delegator, reports, host, archived };
}

const request = (channel: ChannelKey = "discord:1") => ({
	channel,
	target: "open",
	author: OWNER,
	title: "t",
	task: "find it",
});

describe("DefaultDelegator", () => {
	test("a report comes back with its job, after start has returned", async () => {
		const { delegator, reports } = setup(async (task) => `report for ${task}`);
		const job = delegator.start(request());
		expect(reports).toEqual([]);
		await delegator.idle();
		expect(reports).toEqual([
			[job, { ok: true, report: "report for find it" }],
		]);
	});

	test("a channel holds only so many running jobs; other channels are not affected", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { delegator } = setup(async () => {
			await gate;
			return "done";
		});
		delegator.start(request());
		delegator.start(request());
		expect(() => delegator.start(request())).toThrow("already has 2");
		expect(delegator.start(request("discord:2")).id).toBe(3);
		release();
		await delegator.idle();
		expect(delegator.start(request()).id).toBe(4);
		await delegator.idle();
	});

	test("a failing or slow worker reports the failure", async () => {
		const { delegator, reports } = setup(
			(_task, signal) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () =>
						reject(new Error("timed out")),
					),
				),
			10,
		);
		delegator.start(request());
		await delegator.idle();
		expect(reports[0]?.[1]).toEqual({ ok: false, error: "timed out" });
	});

	test("an owner job runs in a thread of its origin, archived with the report before the turn", async () => {
		const { delegator, reports, host, archived } = setup(async () => "R");
		delegator.start({
			...request("discord:dm"),
			target: "main",
			origin: "discord:10",
			title: "check the Bun version",
		});
		await delegator.idle();
		expect(host.opened).toEqual([
			{ parentId: "10", name: "check the Bun version", id: "900" },
		]);
		expect(host.lines.get("10")).toBe(
			messages().threadStarted("check the Bun version", "<#900>"),
		);
		expect(host.textsIn("900")).toEqual([
			messages().delegationTask("find it"),
			messages().delegationDone("R"),
		]);
		expect(archived).toEqual([["900"]]);
		const [job, outcome] = reports[0] ?? [];
		expect(job?.channel).toBe("discord:dm");
		expect(
			delegatedTurnText(
				job as DelegationJob,
				outcome as DelegationOutcome,
				"x",
			),
		).toContain("in the thread <#900>");
	});

	test("a failed or timed-out job's thread gets the failure and is archived", async () => {
		const { delegator, host } = setup(
			(_task, signal) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () =>
						reject(new Error("timed out")),
					),
				),
			10,
		);
		delegator.start({ ...request(), origin: "discord:10" });
		await delegator.idle();
		expect(host.textsIn("900").at(-1)).toBe(
			messages().delegationFailed("timed out"),
		);
		expect(host.closed).toEqual(["900"]);
	});

	test("a job without an origin, or one whose thread cannot open, reports only in its channel", async () => {
		const { delegator, reports, host } = setup(async () => "R");
		delegator.start(request());
		host.failOpen = true;
		delegator.start({ ...request("discord:2"), origin: "discord:2" });
		await delegator.idle();
		expect(host.posts).toEqual([]);
		expect(reports.map(([job]) => job.thread)).toEqual([undefined, undefined]);
		expect(reports.map(([, outcome]) => outcome.ok)).toEqual([true, true]);
	});

	test("each target sets its own running limit", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { delegator } = setup(async () => {
			await gate;
			return "done";
		});
		for (let i = 0; i < 3; i++)
			delegator.start({ ...request(), target: "main" });
		expect(() => delegator.start({ ...request(), target: "main" })).toThrow(
			"already has 3",
		);
		release();
		await delegator.idle();
	});

	test("a target nobody contributes, or one without delegation, is refused", () => {
		const { delegator } = setup(async () => "x");
		expect(() => delegator.start({ ...request(), target: "gone" })).toThrow(
			DelegationError,
		);
		expect(() => delegator.start({ ...request(), target: "closed" })).toThrow(
			"not available for closed conversations",
		);
		expect(delegator.runningChannels()).toEqual([]);
	});

	test("an empty task is refused", () => {
		const { delegator } = setup(async () => "x");
		expect(() => delegator.start({ ...request(), task: " " })).toThrow(
			"required",
		);
	});

	test("the report turn carries the task and the report", () => {
		const job: DelegationJob = { ...request(), id: 5, startedAt: new Date(0) };
		const text = delegatedTurnText(
			job,
			{ ok: true, report: "R" },
			"2026-09-27 01:00",
		);
		expect(text).toContain("## Delegated task #5: t");
		expect(text).toContain("### Task\nfind it");
		expect(text).toContain("### Report\nR");
		expect(delegatedTurnText(job, { ok: false, error: "boom" }, "x")).toContain(
			"failed: boom",
		);
	});
});
