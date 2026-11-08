import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnerPrompts, ToolTurn } from "pi-roundtable";
import { SYSTEM_PRINCIPAL } from "pi-roundtable";
import { servicePair, silentLogger, testPlugin } from "pi-roundtable/testing";
import {
	CodingDesk,
	type CodingJob,
	type CodingResult,
	type CodingWorker,
	codingReport,
} from "./coding-desk.ts";
import { coding } from "./coding-plugin.ts";
import { type SettingsPage, WEB_APP } from "./coding-settings.ts";
import { PiCodingWorker } from "./pi-coding-worker.ts";
import { RepoShelf } from "./repo-shelf.ts";
import { cancelTask, listTasks } from "./task-tools.ts";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
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
async function identity(dir: string) {
	await git(dir, "config", "user.name", "Test User");
	await git(dir, "config", "user.email", "test@example.invalid");
}
async function commit(dir: string, file: string, content: string) {
	writeFileSync(join(dir, file), content);
	await git(dir, "add", file);
	await git(dir, "commit", "-m", `Write ${file}`);
}
/** A shelf with one managed clone, `sample/project`, of a bare origin. */
async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "coding-cancel-"));
	dirs.push(dir);
	const origin = join(dir, "origin.git");
	const seed = join(dir, "seed");
	mkdirSync(origin);
	mkdirSync(seed);
	await git(origin, "init", "--bare", "--initial-branch=main");
	await git(seed, "init", "--initial-branch=main");
	await identity(seed);
	await commit(seed, "README.md", "# Example\n");
	await git(seed, "remote", "add", "origin", origin);
	await git(seed, "push", "-u", "origin", "main");
	const shelf = new RepoShelf(join(dir, "shelf"), async (_repo, path) => {
		await git(dir, "clone", origin, path);
		await identity(path);
	});
	const clone = await shelf.add("sample/project");
	return { shelf, clone };
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function gate<T = void>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const request = (extra: Partial<CodingJob> = {}) => ({
	repo: "sample/project",
	task: "Implement the contract\nwith details",
	channel: "test:room" as const,
	model: "faux/worker",
	thinking: "off" as const,
	skillFiles: [],
	...extra,
});
/** A worker that commits once, then waits until stopped, and records what it saw. */
function stoppableWorker() {
	const started: number[] = [];
	const aborted: number[] = [];
	const committed = gate();
	return {
		started,
		aborted,
		committed: committed.promise,
		worker: {
			run: async (job: CodingJob & { dir: string }, signal: AbortSignal) => {
				started.push(job.id);
				if (job.id === 1) {
					await commit(job.dir, "work.txt", "partial\n");
					committed.resolve();
				}
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					signal.addEventListener("abort", () => resolve());
				});
				aborted.push(job.id);
				return "stopped";
			},
		},
	};
}
function makeDesk(
	shelf: RepoShelf,
	worker: CodingWorker,
	extra: { prompts?: () => OwnerPrompts } = {},
) {
	const results: CodingResult[] = [];
	const desk = new CodingDesk({
		shelf,
		worker,
		maxWorkers: 1,
		logger: silentLogger(),
		deliver: async (result) => {
			results.push(result);
		},
		...extra,
	});
	stops.push(() => desk.stop());
	return { desk, results };
}
const turn = (extra: Partial<ToolTurn> = {}): ToolTurn =>
	({
		speaker: undefined,
		channel: "test:room",
		agent: undefined,
		signal: undefined,
		...extra,
	}) as ToolTurn;
const OWNER_TURN = turn({
	speaker: { id: "o", name: "Olive", tier: "owner", principalId: "p-owner" },
});
const agentTurn = (name: string) =>
	turn({
		speaker: {
			id: "s",
			name: "System",
			tier: "owner",
			principalId: SYSTEM_PRINCIPAL,
		},
		agent: { name, session: "test:a", home: "test:a" },
	});

test("a queued task is dropped and never runs; the others keep their order", async () => {
	const { shelf } = await fixture();
	const work = stoppableWorker();
	const { desk, results } = makeDesk(shelf, work.worker);
	await desk.start(request());
	await desk.start(request());
	await desk.start(request());
	expect(await desk.cancel(2, "Olive")).toMatchObject({ status: "dropped" });
	expect(desk.tasks().map(({ job, status }) => [job.id, status])).toEqual([
		[1, "running"],
		[3, "queued"],
	]);
	await work.committed;
	await desk.cancel(1, "Olive");
	await desk.cancel(3, "Olive");
	await desk.idle();
	expect(work.started).toEqual([1]);
	const dropped = results.find((result) => result.job.id === 2);
	expect(dropped?.outcome).toEqual({
		ok: false,
		error:
			"cancelled by Olive before it ran; nothing ran, so start it again if it is still wanted",
	});
});

test("a running task is aborted, keeps its commits unmerged, and frees its slot for the next", async () => {
	const { shelf, clone } = await fixture();
	const work = stoppableWorker();
	const { desk, results } = makeDesk(shelf, work.worker);
	const before = await git(clone, "rev-parse", "HEAD");
	await desk.start(request());
	await desk.start(request());
	await work.committed;
	const result = await desk.cancel(1, "Olive (wrong brief)");
	expect(work.aborted).toContain(1);
	if (result.status !== "stopped") throw new Error(result.status);
	expect(result.settled).toBe(true);
	expect(result.commits).toHaveLength(1);
	expect(result.branch).toBeDefined();
	expect(result.dir && existsSync(result.dir)).toBe(true);
	// The clone did not move; the branch still holds the commit.
	expect(await git(clone, "rev-parse", "HEAD")).toBe(before);
	expect(
		await git(clone, "log", "--format=%s", "-1", result.branch ?? ""),
	).toBe("Write work.txt");
	// Its slot went to the next queued task.
	while (!work.started.includes(2)) await Bun.sleep(5);
	const report = codingReport(results[0] as CodingResult, "now");
	expect(report).toContain(
		"cancelled by Olive (wrong brief); the worker was stopped and its commits were not merged into the clone",
	);
	expect(report).toContain(
		`Not merged: the task was cancelled by Olive (wrong brief)`,
	);
	expect(report).toContain(
		`The branch ${result.branch} and its worktree ${result.dir} are kept.`,
	);
	expect(report).toContain("Write work.txt");
	await desk.cancel(2, "Olive");
	await desk.idle();
});

test("cancelling a real worker ends its Pi session process and the shell processes it started", async () => {
	const { shelf } = await fixture();
	const dir = mkdtempSync(join(tmpdir(), "coding-cancel-pi-"));
	dirs.push(dir);
	const agentDir = join(dir, "login");
	mkdirSync(agentDir);
	const pi = new PiCodingWorker({
		agentDir,
		packages: [
			fileURLToPath(new URL("./testing/faux-provider.ts", import.meta.url)),
		],
	});
	const asking = gate<string>();
	// The Pi session waits on its approval card, which nobody answers, until the cancel.
	const worker: CodingWorker = {
		run: (job, signal, _review, progress) => {
			writeFileSync(join(job.dir, "start-descendant"), "start");
			return pi.run(
				job,
				signal,
				async () => {
					asking.resolve(job.dir);
					return new Promise(() => {});
				},
				progress,
			);
		},
	};
	const { desk } = makeDesk(shelf, worker);
	await desk.start(request());
	const workDir = await asking.promise;
	const session = Number(readFileSync(join(workDir, "worker.pid"), "utf8"));
	const shell = Number(readFileSync(join(workDir, "descendant.pid"), "utf8"));
	expect([alive(session), alive(shell)]).toEqual([true, true]);
	const result = await desk.cancel(1, "Olive");
	expect(result).toMatchObject({ status: "stopped", settled: true });
	await Bun.sleep(50); // Allow the OS to reap the killed group.
	expect([alive(session), alive(shell)]).toEqual([false, false]);
	await desk.idle();
});

test("a held action the cancelled worker waits on is closed", async () => {
	const { shelf } = await fixture();
	const asked = gate();
	let closed = false;
	const prompts = {
		confirm: (
			_title: string,
			_body: string,
			signal?: AbortSignal,
		): Promise<"approved" | "declined" | "held"> =>
			new Promise((resolve) => {
				asked.resolve();
				signal?.addEventListener("abort", () => {
					closed = true;
					resolve("held");
				});
			}),
	} as unknown as OwnerPrompts;
	const { desk, results } = makeDesk(
		shelf,
		{
			run: async (_job, _signal, review) => {
				await review({
					tool: "bash",
					input: "rm -rf x",
					action: "Delete",
				} as never);
				return "done";
			},
		},
		{ prompts: () => prompts },
	);
	await desk.start(request());
	await asked.promise;
	expect(await desk.cancel(1, "Olive")).toMatchObject({
		status: "stopped",
		commits: [],
		settled: true,
	});
	expect(closed).toBe(true);
	expect(results[0]?.outcome).toMatchObject({ ok: false });
});

test("an unknown or finished task is refused", async () => {
	const { shelf } = await fixture();
	const { desk } = makeDesk(shelf, { run: async () => "done" });
	await desk.start(request());
	await desk.idle();
	expect(await desk.cancel(1, "Olive")).toEqual({
		status: "refused",
		reason:
			"No running or queued coding task #1; it may have finished already.",
	});
	expect(await desk.cancel(99, "Olive")).toMatchObject({ status: "refused" });
});

test("an agent sees and cancels only its own tasks; an owner sees and cancels any", async () => {
	const { shelf } = await fixture();
	const work = stoppableWorker();
	const { desk } = makeDesk(shelf, work.worker);
	await desk.start(request({ agent: "ada" }));
	await desk.start(request({ agent: "bob" }));
	expect(listTasks(desk, agentTurn("ada"))).toMatch(
		/^#1 sample\/project, running since .*, started by ada: Implement the contract$/,
	);
	expect(listTasks(desk, agentTurn("bob"))).toMatch(
		/^#2 .*queued \(position 1\)/,
	);
	expect(listTasks(desk, agentTurn("cy"))).toBe(
		"No running or queued coding tasks you may see.",
	);
	expect(listTasks(desk, OWNER_TURN).split("\n")).toHaveLength(2);
	expect(listTasks(desk, OWNER_TURN, "other/repo")).toContain("No running");
	await expect(
		cancelTask(desk, agentTurn("ada"), { repo: "sample/project", id: 2 }),
	).rejects.toThrow("started by someone else");
	expect(
		await cancelTask(desk, agentTurn("bob"), { repo: "sample/project", id: 2 }),
	).toBe(
		"Dropped coding task #2 in sample/project from the queue; it never ran.",
	);
	await work.committed;
	expect(
		await cancelTask(desk, OWNER_TURN, {
			repo: "sample/project",
			id: 1,
			reason: "wrong brief",
		}),
	).toMatch(
		/^Stopped coding task #1 in sample\/project\. Its commits \(1\) are kept, not merged, on the branch \S+ in the worktree \S+; inspect, merge or delete them\.$/,
	);
	await expect(
		cancelTask(desk, OWNER_TURN, { repo: "sample/project", id: 1 }),
	).rejects.toThrow("No running or queued coding task #1");
	await desk.idle();
});

test("the tools are registered, repo_task names repo_task_cancel, and the Settings page cancels for an owner only", async () => {
	const { shelf } = await fixture();
	const work = stoppableWorker();
	const pages: SettingsPage[] = [];
	const plugin = await testPlugin(
		coding({
			shelfDir: shelf.dir,
			model: "faux/worker",
			maxWorkers: 1,
			worker: work.worker,
			onResult: async () => {},
		}),
		{
			services: [
				servicePair(WEB_APP, {
					registerPage: (page) => pages.push(page),
					pages: { changed: () => {} },
				}),
			],
		},
	);
	stops.push(() => plugin.stop());
	expect(plugin.tools).toEqual(
		expect.arrayContaining(["repo_task_list", "repo_task_cancel"]),
	);
	const owner = {
		speaker: {
			id: "o",
			name: "Olive",
			tier: "owner" as const,
			principalId: "p-o",
		},
	};
	expect(
		await plugin.runTool(
			"repo_task",
			{ repo: "sample/project", task: "One" },
			owner,
		),
	).toContain("repo_task_cancel cancels it");
	expect(
		await plugin.runTool(
			"repo_task",
			{ repo: "sample/project", task: "Two" },
			owner,
		),
	).toContain("repo_task_cancel cancels it");
	expect(await plugin.runTool("repo_task_list", {}, owner)).toContain(
		"#2 sample/project, queued (position 1)",
	);
	const page = pages[0];
	if (!page) throw new Error("no settings page");
	const list = (await page.view({ tier: "owner" })).sections.find(
		(section) => section.kind === "list",
	);
	expect(
		list?.kind === "list" && list.rows.map((row) => row.actions?.[0]?.id),
	).toEqual(["cancel:1", "cancel:2"]);
	expect(list?.kind === "list" && list.rows[1]?.actions?.[0]?.confirm).toBe(
		"Drop coding task #2 from the queue?",
	);
	expect(await page.act({ tier: "admin" }, "cancel:2", {})).toEqual({
		ok: false,
		error: "Only an owner changes this.",
	});
	expect(
		await page.act({ tier: "owner", name: "Olive" }, "cancel:2", {}),
	).toEqual({
		ok: true,
		notice: "Coding task #2 was dropped from the queue.",
	});
	expect(await page.act({ tier: "owner" }, "cancel:2", {})).toEqual({
		ok: false,
		error: "Coding task #2 is no longer running or queued.",
	});
	await work.committed;
	expect(await page.act({ tier: "owner" }, "cancel:1", {})).toMatchObject({
		ok: true,
		notice: expect.stringContaining("was stopped; its commits stay on"),
	});
	expect(
		(await page.view({ tier: "owner" })).sections.some(
			(section) => section.kind === "list",
		),
	).toBe(false);
});
