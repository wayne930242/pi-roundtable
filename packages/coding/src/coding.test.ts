import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatSurface, OwnerPrompts } from "pi-roundtable";
import { SKILLS } from "pi-roundtable";
import {
	fakeThreads,
	OWNER_SPEAKER,
	servicePair,
	silentLogger,
	testPlugin,
} from "pi-roundtable/testing";
import type { CodingLimits } from "./coding-desk.ts";
import {
	CodingDesk,
	type CodingJob,
	type CodingResult,
	type CodingWorker,
} from "./coding-desk.ts";
import { coding } from "./coding-plugin.ts";
import { PiCodingWorker } from "./pi-coding-worker.ts";
import { RepoShelf } from "./repo-shelf.ts";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "coding-test-"));
	dirs.push(dir);
	return dir;
}
async function git(dir: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", "-C", dir, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw new Error(err);
	return out.trim();
}
async function fixture() {
	const dir = temp();
	const origin = join(dir, "origin.git");
	const seed = join(dir, "seed");
	mkdirSync(origin);
	mkdirSync(seed);
	await git(origin, "init", "--bare", "--initial-branch=main");
	await git(seed, "init", "--initial-branch=main");
	await identity(seed);
	writeFileSync(
		join(seed, "README.md"),
		"# Example\n\nAn example repository.\n",
	);
	await git(seed, "add", "README.md");
	await git(seed, "commit", "-m", "Initial");
	await git(seed, "remote", "add", "origin", origin);
	await git(seed, "push", "-u", "origin", "main");
	const shelf = new RepoShelf(join(dir, "shelf"), async (_repo, path) => {
		await git(dir, "clone", origin, path);
		await identity(path);
	});
	return { dir, origin, seed, shelf };
}
async function identity(dir: string) {
	await git(dir, "config", "user.name", "Test User");
	await git(dir, "config", "user.email", "test@example.invalid");
}
async function change(dir: string, filename = "change.txt") {
	writeFileSync(join(dir, filename), "A change.\n");
	await git(dir, "add", filename);
	await git(dir, "commit", "-m", `Add ${filename}`);
}
function gate<T>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function surface(prompts?: OwnerPrompts): ChatSurface & { posts: string[] } {
	const posts: string[] = [];
	return {
		surface: "test",
		posts,
		start: async () => {},
		sendReply: async (_channel, reply) => {
			posts.push(reply.chunks.join("\n"));
		},
		prompts: () => prompts,
	};
}
const request = (repo = "sample/project") => ({
	repo,
	task: "Implement the contract",
	channel: "test:room" as const,
	model: "faux/worker",
	thinking: "off" as const,
	skillFiles: [],
});

test("clones and lists shelf state, refuses invalid names and duplicate clones", async () => {
	const { shelf } = await fixture();
	const dir = await shelf.add("sample/project");
	expect(await shelf.list(false)).toMatchObject([
		{
			repo: "sample/project",
			dir,
			branch: "main",
			upstream: { ahead: 0, behind: 0 },
			uncommitted: 0,
			summary: "An example repository.",
		},
	]);
	await expect(shelf.add("sample/project")).rejects.toThrow("already");
	for (const bad of [
		"../project",
		"sample/..",
		"/tmp/repo",
		"sample/project/other",
		"a b/c",
		"sample/.",
	]) {
		await expect(shelf.add(bad)).rejects.toThrow();
		expect(() => shelf.dirOf(bad)).toThrow();
	}
});
test("report pins the exact commit and default branch; rejects dirty, empty, stale and behind clones", async () => {
	const { shelf, seed, origin } = await fixture();
	const dir = await shelf.add("sample/project");
	await expect(shelf.report("sample/project")).rejects.toThrow("nothing");
	writeFileSync(join(dir, "dirty.txt"), "dirty");
	await expect(shelf.report("sample/project")).rejects.toThrow("uncommitted");
	rmSync(join(dir, "dirty.txt"));
	await change(dir);
	const report = await shelf.report("sample/project");
	expect(report.sha).toHaveLength(40);
	expect(report.branch).toBe("main");
	expect(report.diffstat).toContain("change.txt");
	await change(dir, "second.txt");
	await expect(shelf.push("sample/project", report.sha)).rejects.toThrow(
		"not HEAD",
	);
	const latest = await shelf.report("sample/project");
	await shelf.push("sample/project", latest.sha);
	expect(await git(origin, "rev-parse", "main")).toBe(latest.sha);
	await git(seed, "pull", "--ff-only");
	await change(seed, "remote.txt");
	await git(seed, "push");
	await expect(shelf.report("sample/project")).rejects.toThrow("lacks");
});
test("symlinked clones and owner paths cannot escape the shelf", async () => {
	const { shelf, dir, seed } = await fixture();
	mkdirSync(shelf.dir);
	symlinkSync(dir, join(shelf.dir, "escape"));
	await expect(shelf.add("escape/project")).rejects.toThrow("escapes");
	mkdirSync(join(shelf.dir, "sample"));
	symlinkSync(seed, join(shelf.dir, "sample", "project"));
	expect(() => shelf.dirOf("sample/project")).toThrow("escapes");
});
test("plugin push is held until owner approval, then pushes the reported SHA", async () => {
	const { shelf, origin } = await fixture();
	const chat = surface();
	const harness = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/worker",
			clone: async (_repo, path) => {
				await git(shelf.dir, "clone", origin, path);
				await identity(path);
			},
		}),
		{ surfaces: [chat] },
	);
	stops.push(() => harness.stop());
	expect(harness.tools).toEqual([
		"repo_list",
		"repo_add",
		"repo_change_report",
		"repo_push",
		"repo_task",
	]);
	await harness.runTool("repo_add", { repo: "sample/project" });
	await change(shelf.dirOf("sample/project"));
	const before = await git(origin, "rev-parse", "main");
	const text = await harness.runTool(
		"repo_change_report",
		{ repo: "sample/project" },
		{ channel: "test:room" },
	);
	const sha = await git(shelf.dirOf("sample/project"), "rev-parse", "HEAD");
	expect(text).toContain(sha);
	expect(chat.posts[0]).toContain("Changed files");
	const action = harness.holds(
		"repo_push",
		{ repo: "sample/project", sha },
		{},
	);
	expect(action).toContain(sha);
	expect(await git(origin, "rev-parse", "main")).toBe(before);
	// testPlugin exposes the linked hold rule; the host runtime is the approval gate.
	const approval = gate<"approved" | "declined">();
	const push = (async () => {
		if ((await approval.promise) === "approved")
			return harness.runTool(
				"repo_push",
				{ repo: "sample/project", sha },
				{ speaker: OWNER_SPEAKER },
			);
		return "Declined";
	})();
	expect(await git(origin, "rev-parse", "main")).toBe(before);
	approval.resolve("approved");
	expect(await push).toContain("Pushed");
	expect(await git(origin, "rev-parse", "main")).toBe(sha);
});
test("owner-repo exception is exact and defaults to no exception", async () => {
	const harness = await testPlugin(
		coding({
			shelfDir: temp(),
			model: "faux/worker",
			ownerRepos: ["sample/owned"],
		}),
	);
	stops.push(() => harness.stop());
	expect(
		harness.holds(
			"repo_push",
			{ repo: "sample/owned", sha: "a".repeat(40) },
			{},
		),
	).toBeUndefined();
	for (const repo of ["sample/owned-other", "sample/project", "other/owned"])
		expect(
			harness.holds("repo_push", { repo, sha: "a".repeat(40) }, {}),
		).toContain("Push");
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
	expect(result.state?.branch).toBe("main");
	expect(desk.busy()).toEqual([]);
});
test("missing, declined and failed cards fail closed, and jobs reserve before awaiting", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	for (const mode of ["missing", "declined", "failed"] as const) {
		const delivered = gate<CodingResult>();
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
				run: async (_job, _signal, review) =>
					`${await review({ tool: "bash", input: "{}", action: "risky operation" })}`,
			},
		});
		await desk.start(request());
		await expect(desk.start(request())).rejects.toThrow(
			"Coding task #1 is still working in sample/project; one worker runs per repository.",
		);
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
test("real out-of-process Pi worker requests host approval and cannot execute a refused call", async () => {
	const { shelf, dir } = await fixture();
	const repoDir = await shelf.add("sample/project");
	const agentDir = join(dir, "login");
	mkdirSync(agentDir);
	const extension = fileURLToPath(
		new URL("./testing/faux-provider.ts", import.meta.url),
	);
	for (const answer of ["approved", "declined", "held"] as const) {
		const marker = join(repoDir, "..", "approval-marker.txt");
		rmSync(marker, { force: true });
		let reviewed = 0;
		const worker = new PiCodingWorker({ agentDir, packages: [extension] });
		const job: CodingJob & { dir: string } = {
			...request(),
			id: 1,
			startedAt: new Date(),
			startHead: "",
			dir: repoDir,
		};
		const report = await worker.run(
			job,
			AbortSignal.timeout(10_000),
			async (call) => {
				reviewed++;
				expect(call.action).toContain("write");
				expect(existsSync(marker)).toBe(false);
				return answer;
			},
		);
		expect(reviewed).toBe(1);
		expect(existsSync(marker)).toBe(answer === "approved");
		const pid = Number(report.match(/pid=(\d+)/)?.[1]);
		expect(pid).not.toBe(process.pid);
		expect(() => process.kill(pid, 0)).toThrow();
		if (answer !== "approved") expect(report).toContain("Do not retry");
	}
});

test("a host words what the worker reads when a call is declined or held", async () => {
	const { shelf, dir } = await fixture();
	const repoDir = await shelf.add("sample/project");
	const agentDir = join(dir, "login");
	mkdirSync(agentDir);
	const extension = fileURLToPath(
		new URL("./testing/faux-provider.ts", import.meta.url),
	);
	for (const answer of ["declined", "held"] as const) {
		const worker = new PiCodingWorker({
			agentDir,
			packages: [extension],
			blockText: (kind, action) =>
				`Host wording for ${kind}: it would ${action}.`,
		});
		const report = await worker.run(
			{
				...request(),
				id: 1,
				startedAt: new Date(),
				startHead: "",
				dir: repoDir,
			},
			AbortSignal.timeout(10_000),
			async () => answer,
		);
		expect(report).toContain(`Host wording for ${answer}: it would write`);
		expect(report).not.toContain("Do not retry");
	}
});

test("metadata never follows links or reads directories, FIFOs or bytes past its limit", async () => {
	const { shelf, dir } = await fixture();
	const clone = await shelf.add("sample/project");
	const outside = join(dir, "host-data.txt");
	writeFileSync(outside, "Outside prose must stay outside.\n");
	rmSync(join(clone, "README.md"));
	symlinkSync(outside, join(clone, "README.md"));
	expect((await shelf.list(false))[0]?.summary).toBeUndefined();
	rmSync(join(clone, "README.md"));
	mkdirSync(join(clone, "README.md"));
	expect((await shelf.list(false))[0]?.summary).toBeUndefined();
	rmSync(join(clone, "README.md"), { recursive: true });
	const pipe = Bun.spawn(["mkfifo", join(clone, "README.md")], {
		stdout: "ignore",
		stderr: "ignore",
	});
	expect(await pipe.exited).toBe(0);
	expect((await shelf.list(false))[0]?.summary).toBeUndefined();
	rmSync(join(clone, "README.md"));
	writeFileSync(
		join(clone, "README.md"),
		`${" ".repeat(65_536)}Beyond metadata limit.\n`,
	);
	expect((await shelf.list(false))[0]?.summary).toBeUndefined();
	const outsideWorkflows = join(dir, "outside-workflows");
	mkdirSync(outsideWorkflows);
	writeFileSync(join(outsideWorkflows, "ci.yml"), "on: [push]\n");
	symlinkSync(outsideWorkflows, join(clone, ".github"));
	expect((await shelf.list(false))[0]?.ciOnPush).toBe(false);
	rmSync(join(clone, ".github"));
	mkdirSync(join(clone, ".github"));
	symlinkSync(outsideWorkflows, join(clone, ".github", "workflows"));
	expect((await shelf.list(false))[0]?.ciOnPush).toBe(false);
	rmSync(join(clone, ".github", "workflows"));
	mkdirSync(join(clone, ".github", "workflows"));
	symlinkSync(
		join(outsideWorkflows, "ci.yml"),
		join(clone, ".github", "workflows", "ci.yml"),
	);
	expect((await shelf.list(false))[0]?.ciOnPush).toBe(false);
});

test("push binds its destination and current remote default branch, and refuses credential URLs", async () => {
	const { shelf, dir, origin } = await fixture();
	const clone = await shelf.add("sample/project");
	await change(clone);
	const report = await shelf.report("sample/project");
	expect(report.target).toBe(origin);
	expect(shelf.pushDescription("sample/project", report.sha)).toContain(
		`branch main`,
	);
	expect(shelf.pushDescription("sample/project", report.sha)).toContain(origin);
	const other = join(dir, "other.git");
	mkdirSync(other);
	await git(other, "init", "--bare", "--initial-branch=main");
	await git(clone, "remote", "set-url", "--push", "origin", other);
	await expect(shelf.push("sample/project", report.sha)).rejects.toThrow(
		"destination changed",
	);
	await git(clone, "remote", "set-url", "--push", "origin", origin);
	await git(
		origin,
		"update-ref",
		"refs/heads/next",
		await git(origin, "rev-parse", "main"),
	);
	await git(origin, "symbolic-ref", "HEAD", "refs/heads/next");
	await git(clone, "fetch", "origin");
	await expect(shelf.push("sample/project", report.sha)).rejects.toThrow(
		"default branch changed",
	);
	await git(
		clone,
		"remote",
		"set-url",
		"--push",
		"origin",
		"https://fixture:placeholder@example.invalid/repo.git",
	);
	await expect(shelf.report("sample/project")).rejects.toThrow(
		"credential helper",
	);
});

test("host Git disables repository hooks and fsmonitor", async () => {
	const { shelf, dir } = await fixture();
	const clone = await shelf.add("sample/project");
	await change(clone);
	const marker = join(dir, "hook-ran");
	const monitor = join(dir, "monitor");
	writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
	await git(clone, "config", "core.fsmonitor", monitor);
	writeFileSync(
		join(clone, ".git", "hooks", "pre-push"),
		`#!/bin/sh\ntouch '${marker}'\n`,
		{ mode: 0o755 },
	);
	await shelf.list(false);
	const report = await shelf.report("sample/project");
	await shelf.push("sample/project", report.sha);
	expect(existsSync(marker)).toBe(false);
});

test("rejects timer overflow and bounds injected worker reports and held inputs", async () => {
	const shelf = {
		dirOf: () => "/tmp",
		state: async () => ({ branch: "main", head: "abc123", uncommitted: [] }),
		commitsSince: async () => [],
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

test("trusted host hooks preserve caller identity, carried skills, queued delivery and separate report wording", async () => {
	const { shelf } = await fixture();
	const dir = await shelf.add("sample/project");
	await change(dir);
	const delivered = gate<CodingResult>();
	const posts: string[] = [];
	const chat = surface();
	const harness = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/default",
			resolveRun: (turn) => {
				expect(turn.channel).toBe("test:origin");
				return {
					model: "faux/caller",
					thinking: "high",
					channel: "test:home",
					origin: turn.channel,
				};
			},
			worker: {
				run: async (job) => {
					expect(job).toMatchObject({
						model: "faux/caller",
						thinking: "high",
						channel: "test:home",
						origin: "test:origin",
						skillNames: ["base", "loaded"],
						skillFiles: ["/skills/base", "/skills/loaded"],
					});
					return "Verified.";
				},
			},
			onResult: async (result) => delivered.resolve(result),
			postChangeReport: async (turn, text) => {
				expect(turn.channel).toBe("test:origin");
				posts.push(text);
			},
			presentation: {
				taskStarted: (job, skipped) =>
					`Queued ${job.model}; skipped ${skipped.join(",")}`,
				changeReport: (report) => ({
					post: `Record ${report.sha}`,
					result: `Ship ${report.sha}`,
				}),
			},
		}),
		{
			surfaces: [chat],
			services: [
				servicePair(SKILLS, {
					checkRegistered: () => {},
					resolve: (names) => ({
						skills: ["base", ...names.filter((name) => name !== "missing")].map(
							(name) => ({
								name,
								description: "Fixture",
								file: `/skills/${name}`,
							}),
						),
						missing: names
							.filter((name) => name === "missing")
							.map((name) => ({ name, reason: "unavailable" })),
					}),
				}),
			],
		},
	);
	stops.push(() => harness.stop());
	expect(
		await harness.runTool(
			"repo_change_report",
			{ repo: "sample/project" },
			{ channel: "test:origin" },
		),
	).toStartWith("Ship ");
	expect(posts[0]).toStartWith("Record ");
	expect(chat.posts).toEqual([]);
	// Explicit missing skills refuse before any run.
	expect(
		await harness.runTool(
			"repo_task",
			{ repo: "sample/project", task: "Work", skills: ["missing"] },
			{ channel: "test:origin" },
		),
	).toContain("cannot load");
	expect(
		await harness.runTool(
			"repo_task",
			{ repo: "sample/project", task: "Work", skills: ["loaded"] },
			{ channel: "test:origin" },
		),
	).toBe("Queued faux/caller; skipped ");
	expect((await delivered.promise).job.channel).toBe("test:home");
	expect(chat.posts).toEqual([]);
});

test("owner policy is host-owned, validates names, and does not bypass linked hold rules", async () => {
	const seen: string[] = [];
	const plugin = coding({
		shelfDir: temp(),
		model: "faux/worker",
		isOwnerRepo: (repo) => {
			seen.push(repo);
			return repo.startsWith("sample/");
		},
	});
	const harness = await testPlugin({
		...plugin,
		setup: async (context) => ({
			...(await plugin.setup(context)),
			holdRules: [
				{
					name: "host-policy",
					describe: (tool) =>
						tool === "repo_push" ? "Host requires approval" : undefined,
				},
			],
		}),
	});
	stops.push(() => harness.stop());
	const sha = "a".repeat(40);
	expect(harness.holds("repo_push", { repo: "sample/future", sha }, {})).toBe(
		"Host requires approval",
	);
	expect(
		harness.holds("repo_push", { repo: "samples/future", sha }, {}),
	).toContain("Push");
	expect(() =>
		harness.holds("repo_push", { repo: "sample/../escape", sha }, {}),
	).toThrow();
	expect(seen).not.toContain("sample/../escape");
});

test("a trusted host can word the held push card without changing who is held", async () => {
	const harness = await testPlugin(
		coding({
			shelfDir: temp(),
			model: "faux/worker",
			isOwnerRepo: (repo) => repo.startsWith("sample/"),
			pushHoldText: (repo, sha) => `ship ${sha} of ${repo}`,
		}),
	);
	stops.push(() => harness.stop());
	const sha = "b".repeat(40);
	expect(harness.holds("repo_push", { repo: "samples/app", sha }, {})).toBe(
		`ship ${sha} of samples/app`,
	);
	expect(
		harness.holds("repo_push", { repo: "sample/app", sha }, {}),
	).toBeUndefined();
});

test("adoption preserves a legacy clone once and refuses symlink escapes before moving it", async () => {
	const { shelf, dir, seed } = await fixture();
	const from = join(dir, "legacy");
	await git(dir, "clone", seed, from);
	const harness = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/worker",
			adoptClones: [{ from, repo: "sample/project" }],
		}),
	);
	stops.push(() => harness.stop());
	expect(existsSync(from)).toBe(false);
	expect(shelf.repos()).toEqual(["sample/project"]);
	expect(shelf.adopt(from, "sample/project")).toBe(false);
	const another = join(dir, "another");
	await git(dir, "clone", seed, another);
	expect(shelf.adopt(another, "sample/project")).toBe(false);
	expect(existsSync(another)).toBe(true);
	symlinkSync(dir, join(shelf.dir, "escape"));
	expect(() => shelf.adopt(another, "escape/project")).toThrow("escapes");
	expect(existsSync(another)).toBe(true);
	const link = join(dir, "linked");
	symlinkSync(another, link);
	expect(() => shelf.adopt(link, "sample/linked")).toThrow("standalone");
});

test("threads own approval cards, archive before result delivery, and never fall back when absent", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	for (const origin of ["discord:origin", undefined] as const) {
		const { host, threads } = fakeThreads();
		const asked: string[] = [];
		const results: CodingResult[] = [];
		const desk = new CodingDesk({
			shelf,
			threads,
			logger: silentLogger(),
			threadText: {
				initial: (job) => `Start ${job.task}`,
				held: () => "Awaiting approval",
				approvalTitle: () => "Host approval",
				report: () => "Host report",
			},
			prompts: (channel) => ({
				confirm: async (title) => {
					asked.push(`${channel}: ${title}`);
					return "expired";
				},
				ask: async () => undefined,
			}),
			worker: {
				run: async (_job, _signal, review) =>
					`${await review({ tool: "bash", input: "{}", action: "push" })}`,
			},
			deliver: async (result) => {
				if (origin) expect(host.closed).toEqual(["900"]);
				results.push(result);
			},
		});
		await desk.start({ ...request(), origin });
		await desk.idle();
		if (origin) {
			expect(host.opened[0]?.parentId).toBe("origin");
			expect(asked).toEqual(["discord:900: Host approval"]);
			expect(host.textsIn("900")).toEqual([
				"Start Implement the contract",
				"Awaiting approval",
				"Host report",
			]);
		} else expect(asked).toEqual([]);
		expect(results[0]?.outcome).toEqual({ ok: true, report: "held" });
		await desk.stop();
	}
});

test("thread failures cannot discard the worker result", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const delivered: CodingResult[] = [];
	const desk = new CodingDesk({
		shelf,
		logger: silentLogger(),
		threads: {
			open: async () => ({
				id: "1",
				channel: "test:thread",
				mention: "#1",
				post: async () => {
					throw new Error("offline");
				},
				close: async () => {
					throw new Error("offline");
				},
			}),
		},
		worker: {
			run: async (_job, _signal, review) =>
				`${await review({ tool: "bash", input: "{}", action: "push" })}`,
		},
		deliver: async (result) => {
			delivered.push(result);
		},
	});
	await desk.start(request());
	await desk.idle();
	expect(delivered[0]?.outcome).toEqual({ ok: true, report: "held" });
	expect(delivered[0]?.held).toHaveLength(1);
	await desk.stop();
});

test("unavailable implicit skills require explicit host opt-in and are disclosed; explicit requests always refuse", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	for (const skipUnavailableCarriedSkills of [false, true]) {
		const harness = await testPlugin(
			coding({
				shelfDir: shelf.dir,
				model: "faux/worker",
				skipUnavailableCarriedSkills,
				worker: { run: async () => "Checked." },
				onResult: async () => {},
			}),
			{
				services: [
					servicePair(SKILLS, {
						checkRegistered: () => {},
						resolve: () => ({
							skills: [],
							missing: [{ name: "unavailable", reason: "missing file" }],
						}),
					}),
				],
			},
		);
		try {
			expect(
				await harness.runTool("repo_task", {
					repo: "sample/project",
					task: "Work",
					skills: ["unavailable"],
				}),
			).toContain("cannot load");
			const text = await harness.runTool("repo_task", {
				repo: "sample/project",
				task: "Work",
			});
			expect(text).toContain(
				skipUnavailableCarriedSkills
					? "Unavailable implicit skills skipped: unavailable."
					: "cannot load",
			);
		} finally {
			await harness.stop();
		}
	}
});

function definitions(harness: Awaited<ReturnType<typeof testPlugin>>) {
	const found: Record<
		string,
		{
			description: string;
			parameters: {
				properties: Record<string, { description?: string; pattern?: string }>;
			};
		}
	> = {};
	for (const tool of harness.contribution.tools ?? []) {
		const factory = tool.session.snapshot().factory({
			kind: "agent",
			homeChannel: "test:1",
			turnChannel: "test:1",
			compaction: { wrap: (item: unknown) => item },
			speaker: () => undefined,
			runTask: async () => "",
		} as never);
		factory?.({
			registerTool: (definition: {
				name: string;
				description: string;
				parameters: never;
			}) => {
				found[definition.name] = definition;
			},
		} as never);
	}
	return found;
}

test("a trusted host words the tools, their arguments and the repo_list result, and push takes a short sha", async () => {
	const { shelf, origin } = await fixture();
	const chat = surface();
	const harness = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/worker",
			clone: async (_repo, path) => {
				await git(shelf.dir, "clone", origin, path);
				await identity(path);
			},
			toolText: {
				repo_task: {
					description: "Hand a coding task over.",
					parameters: { repo: "As repo_list shows it.", task: "The contract." },
				},
				repo_push: { parameters: { sha: "From repo_change_report." } },
			},
			presentation: {
				list: (repos, { shelfDir, fetched }) =>
					`${repos.length} in ${shelfDir}${fetched ? " (fetched)" : ""}`,
			},
			ownerRepos: ["sample/project"],
		}),
		{ surfaces: [chat] },
	);
	stops.push(() => harness.stop());
	const tools = definitions(harness);
	expect(tools.repo_task?.description).toBe("Hand a coding task over.");
	expect(tools.repo_task?.parameters.properties.repo?.description).toBe(
		"As repo_list shows it.",
	);
	expect(tools.repo_task?.parameters.properties.task?.description).toBe(
		"The contract.",
	);
	expect(tools.repo_push?.parameters.properties.sha).toMatchObject({
		pattern: "^[0-9a-f]{7,40}$",
		description: "From repo_change_report.",
	});
	// Unworded tools keep the package defaults.
	expect(tools.repo_list?.description).toContain("List managed clones");
	await harness.runTool("repo_add", { repo: "sample/project" });
	expect(await harness.runTool("repo_list", { fetch: true })).toBe(
		`1 in ${shelf.dir} (fetched)`,
	);
	await change(shelf.dirOf("sample/project"));
	await harness.runTool("repo_change_report", { repo: "sample/project" });
	const sha = await git(shelf.dirOf("sample/project"), "rev-parse", "HEAD");
	expect(
		harness.holds(
			"repo_push",
			{ repo: "samples/x", sha: sha.slice(0, 12) },
			{},
		),
	).toContain(sha.slice(0, 12));
	const pushed = await harness.runTool("repo_push", {
		repo: "sample/project",
		sha: sha.slice(0, 12),
	});
	expect(pushed).toContain("Pushed");
	expect(
		await harness.runTool("repo_push", { repo: "sample/project", sha: "abc" }),
	).toContain("is not HEAD");
});

test("git and gh failures carry their scrubbed stderr, not a login hint", async () => {
	const { shelf } = await fixture();
	const failing = new RepoShelf(shelf.dir, async () => {
		throw new Error("unused");
	});
	await expect(failing.report("sample/nothing")).rejects.toThrow(
		"not a managed repository",
	);
	const clone = await shelf.add("sample/project");
	await git(
		clone,
		"remote",
		"set-url",
		"origin",
		"https://fixture:hunter2@example.invalid/none.git",
	);
	await git(
		clone,
		"remote",
		"set-url",
		"--push",
		"origin",
		"https://example.invalid/none.git",
	);
	let message = "";
	try {
		await shelf.report("sample/project");
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toMatch(/^git fetch failed in .+: .+/);
	expect(message).not.toContain("hunter2");
	expect(message).not.toContain("check the clone and the host's Git login");
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
