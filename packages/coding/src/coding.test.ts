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
import { OWNER_SPEAKER, silentLogger, testPlugin } from "pi-roundtable/testing";
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
		error: expect.stringContaining("Work timeout"),
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
		await expect(desk.start(request())).rejects.toThrow("still using");
		const result = await delivered.promise;
		await desk.idle();
		expect(result.held).toHaveLength(1);
		expect(result.outcome).toMatchObject({
			ok: true,
			report: mode === "declined" ? "declined" : "held",
		});
		await desk.stop();
	}
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
