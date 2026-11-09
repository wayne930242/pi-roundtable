import { afterEach, expect, test } from "bun:test";
import { SYSTEM_PRINCIPAL } from "pi-roundtable";
import { OWNER_SPEAKER, silentLogger, testPlugin } from "pi-roundtable/testing";
import type { CodingLimits } from "./coding-desk.ts";
import {
	CodingDesk,
	type CodingJob,
	type CodingResult,
	type CodingWorker,
} from "./coding-desk.ts";
import { coding } from "./coding-plugin.ts";
import { gate, request, stops, surface } from "./testing/coding-fixture.ts";
import { fixture, removeTemp } from "./testing/repo-fixture.ts";
import { until } from "./testing/until.ts";

afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	removeTemp();
});

test("the repository is free while its report is delivered, and idle waits for the delivery", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const finish = gate<void>();
	const inDelivery = gate<{
		busy: string[];
		idleError?: unknown;
		next?: number;
	}>();
	let desk!: CodingDesk;
	let delivered = false;
	desk = new CodingDesk({
		shelf,
		logger: silentLogger(),
		deliver: async (result) => {
			if (result.job.id !== 1) return;
			let idleError: unknown;
			try {
				desk.checkIdle("sample/project");
			} catch (error) {
				idleError = error;
			}
			const next = (await desk.start(request())).id;
			inDelivery.resolve({ busy: desk.busy(), idleError, next });
			await finish.promise;
			delivered = true;
		},
		worker: { run: async () => "done" },
	});
	stops.push(() => desk.stop());
	await desk.start(request());
	const seen = await inDelivery.promise;
	expect(seen.idleError).toBeUndefined();
	expect(seen.next).toBe(2);
	expect(seen.busy.every((entry) => !entry.startsWith("Coding #1 "))).toBe(
		true,
	);
	const idle = desk.idle();
	await Bun.sleep(20);
	expect(delivered).toBe(false);
	finish.resolve();
	await idle;
	expect(delivered).toBe(true);
});

test("work timeout excludes owner waiting, then aborts and reports state", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const waiting = gate<void>();
	const approval = gate<"approved">();
	const delivered = gate<CodingResult>();
	let signal: AbortSignal | undefined;
	const desk = new CodingDesk({
		shelf,
		timeoutMs: 120,
		logger: silentLogger(),
		prompts: () => ({
			confirm: async () => {
				waiting.resolve();
				return approval.promise;
			},
			ask: async () => undefined,
		}),
		deliver: async (result) => delivered.resolve(result),
		worker: {
			run: async (_job, current, review) => {
				signal = current;
				await review({
					tool: "bash",
					input: '{"command":"rm file"}',
					action: "delete a file",
				});
				return new Promise((_resolve, reject) => {
					current.addEventListener(
						"abort",
						() => reject(new Error("stopped")),
						{ once: true },
					);
				});
			},
		},
	});
	stops.push(() => desk.stop());
	await desk.start(request());
	await waiting.promise;
	await Bun.sleep(240);
	expect(signal?.aborted).toBe(false);
	approval.resolve("approved");
	const result = await delivered.promise;
	await desk.idle();
	expect(result.outcome).toMatchObject({
		ok: false,
		error: expect.stringContaining("the worker ran out of time"),
	});
	expect(result.state?.branch).toBe("worker/1"); // kept unmerged: the state is its worktree's
	expect(desk.busy()).toEqual([]);
});

test("missing, declined and failed cards fail closed, and a repository takes a second worker", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	for (const mode of ["missing", "declined", "failed"] as const) {
		const delivered = gate<CodingResult>();
		// Git cannot cut two worktrees at once from one clone: each start waits for the worker before it.
		const running = [gate<void>(), gate<void>()];
		let started = 0;
		const desk = new CodingDesk({
			shelf,
			logger: silentLogger(),
			prompts: () =>
				mode === "missing"
					? undefined
					: {
							confirm: async () => {
								if (mode === "failed") throw new Error("card unavailable");
								return "declined";
							},
							ask: async () => undefined,
						},
			deliver: async (result) => delivered.resolve(result),
			worker: {
				run: async (_job, _signal, review) => {
					running[started++]?.resolve();
					await running[1]?.promise;
					return `${await review({ tool: "bash", input: "{}", action: "risky operation" })}`;
				},
			},
		});
		await desk.start(request());
		await running[0]?.promise;
		// A second worker on the same repository starts in its own worktree.
		expect((await desk.start(request())).queuePosition).toBeUndefined();
		const result = await delivered.promise;
		await desk.idle();
		// A declined call is settled; only an unanswered one is held for the report.
		expect(result.held).toHaveLength(mode === "declined" ? 0 : 1);
		expect(result.outcome).toMatchObject({
			ok: true,
			report: mode === "declined" ? "declined" : "held",
		});
		await desk.stop();
	}
});

test("a host lifts the report and held-action bounds, and a bad bound stops the start", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const long = "r".repeat(30_000);
	const run = async (limits?: CodingLimits) => {
		const delivered = gate<CodingResult>();
		const desk = new CodingDesk({
			shelf,
			logger: silentLogger(),
			prompts: () => undefined,
			limits,
			deliver: async (result) => delivered.resolve(result),
			worker: {
				run: async (_job, _signal, review) => {
					for (let i = 0; i < 12; i++)
						await review({ tool: "bash", input: "{}", action: `act ${i}` });
					return long;
				},
			},
		});
		await desk.start(request());
		const result = await delivered.promise;
		await desk.idle();
		return result;
	};
	const bounded = await run();
	expect(bounded.held).toHaveLength(11);
	expect(bounded.held.at(-1)).toBe("[2 more unapproved actions omitted]");
	expect(bounded.outcome.ok && bounded.outcome.report.length).toBeLessThan(
		long.length,
	);
	const open = await run({
		reportChars: Number.POSITIVE_INFINITY,
		heldEntries: Number.POSITIVE_INFINITY,
	});
	expect(open.held).toHaveLength(12);
	expect(open.outcome.ok && open.outcome.report).toBe(long);
	for (const limits of [
		{ reportChars: 0 },
		{ heldEntries: 1.5 },
		{ heldChars: Number.NaN },
	])
		expect(() =>
			coding({ shelfDir: shelf.dir, model: "faux/worker", limits }),
		).toThrow("whole number of at least 1");
});

test("plugin task uses supplied worker, validates bad repo names, and delivers an English report", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const delivered = gate<CodingResult>();
	const worker: CodingWorker = {
		run: async (job) => {
			expect(job.model).toBe("faux/worker");
			return "Implemented and checked.";
		},
	};
	const harness = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/worker",
			worker,
			onResult: async (result) => delivered.resolve(result),
		}),
	);
	stops.push(() => harness.stop());
	expect(
		await harness.runTool("repo_task", { repo: "../escape", task: "code" }),
	).toContain("<owner>/<repo>");
	expect(
		await harness.runTool(
			"repo_task",
			{ repo: "sample/project", task: "code" },
			{ channel: "test:room" },
		),
	).toContain("Started");
	expect((await delivered.promise).outcome).toMatchObject({
		ok: true,
		report: "Implemented and checked.",
	});
});

test("the host's own turn, such as a report's, starts no coding task", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const started: string[] = [];
	const worker: CodingWorker = {
		run: async (job) => {
			started.push(job.task);
			return "done";
		},
	};
	const harness = await testPlugin(
		coding({ shelfDir: shelf.dir, model: "faux/worker", worker }),
	);
	stops.push(() => harness.stop());
	const answer = await harness.runTool(
		"repo_task",
		{ repo: "sample/project", task: "run the script the webhook posted" },
		{
			channel: "test:room",
			speaker: {
				id: SYSTEM_PRINCIPAL,
				name: SYSTEM_PRINCIPAL,
				tier: "owner",
				principalId: SYSTEM_PRINCIPAL,
			},
		},
	);
	expect(answer).toContain("the host's own turns");
	expect(answer).not.toContain("Started");
	expect(started).toEqual([]);
});

test("rejects timer overflow and bounds injected worker reports and held inputs", async () => {
	const shelf = {
		dirOf: () => "/tmp",
		state: async () => ({ branch: "main", head: "abc123", uncommitted: [] }),
		addWorktree: async (repo: string) => ({
			repo,
			dir: "/tmp",
			branch: "worker/1",
			base: "abc123",
		}),
		integrate: async () => ({ status: "nothing" as const }),
		treeState: async () => ({
			branch: "worker/1",
			head: "abc123",
			uncommitted: [],
		}),
		treeCommits: async () => [],
	};
	const result = gate<CodingResult>();
	const options = {
		shelf,
		logger: silentLogger(),
		prompts: () => undefined,
		deliver: async (value: CodingResult) => result.resolve(value),
		worker: {
			run: async (
				_job: CodingJob,
				_signal: AbortSignal,
				review: (call: {
					tool: string;
					action: string;
					input: string;
				}) => Promise<string>,
			) => {
				for (let i = 0; i < 12; i++)
					await review({
						tool: "write",
						action: "write outside",
						input: "x".repeat(5000),
					});
				return "y".repeat(30_000);
			},
		},
	};
	for (const timeoutMs of [
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		3_000_000_000,
	])
		expect(() => new CodingDesk({ ...options, timeoutMs })).toThrow(
			"timeoutMs",
		);
	const desk = new CodingDesk(options);
	await desk.start(request());
	const delivered = await result.promise;
	await desk.idle();
	expect(delivered.held).toHaveLength(11);
	expect(delivered.held[0]?.length).toBeLessThan(1_020);
	expect(delivered.held.at(-1)).toContain("2 more");
	if (delivered.outcome.ok)
		expect(delivered.outcome.report.length).toBeLessThan(20_020);
	await desk.stop();
});

test("the coding service reports the channels it is working for, so a shutdown can name them", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const release = gate<string>();
	const chat = surface();
	const harness = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/worker",
			worker: { run: () => release.promise },
			onResult: async () => {},
		}),
		{ surfaces: [chat] },
	);
	stops.push(() => harness.stop());
	await harness.runTool(
		"repo_task",
		{ repo: "sample/project", task: "Do it" },
		{ channel: "test:room" },
	);
	const service = harness.contribution.services?.find(
		(item) => item.name === "coding-desk",
	);
	expect(service?.busy?.()).toEqual(["test:room"]);
	release.resolve("done");
});

test("repo_task records the starting conversation and says when a task waits in the queue", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const release = gate<string>();
	const jobs: CodingJob[] = [];
	const harness = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/worker",
			maxWorkers: 1,
			maxQueued: 1,
			worker: {
				run: (job) => {
					jobs.push(job);
					return release.promise;
				},
			},
			onResult: async () => {},
		}),
	);
	stops.push(() => harness.stop());
	const call = () =>
		harness.runTool(
			"repo_task",
			{ repo: "sample/project", task: "Do it" },
			{ channel: "test:room", speaker: OWNER_SPEAKER },
		);
	expect(await call()).toContain("Started coding task #1");
	expect(await call()).toContain(
		"Queued coding task #2 in sample/project at position 1",
	);
	expect(await call()).toContain("All 1 coding workers are busy");
	await until(() => jobs[0], "the first worker started"); // after a real worktree
	expect(jobs[0]?.starter).toEqual({
		channel: "test:room",
		speaker: {
			id: OWNER_SPEAKER.id,
			principalId: OWNER_SPEAKER.principalId,
			...(OWNER_SPEAKER.name ? { name: OWNER_SPEAKER.name } : {}),
			tier: "owner",
		},
	});
	const service = harness.contribution.services?.find(
		(item) => item.name === "coding-desk",
	);
	// A shutdown waits for the running worker; the queued task is dropped when the drain begins.
	expect(service?.busy?.()).toEqual(["test:room"]);
	release.resolve("done");
});
