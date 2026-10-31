import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoApproval, HeldCall, OwnerPrompts } from "pi-roundtable";
import { SYSTEM_PRINCIPAL } from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import {
	CodingDesk,
	type CodingDeskOptions,
	type CodingJob,
	type CodingResult,
	codingReport,
} from "./coding-desk.ts";
import { RepoShelf, WORKTREES_DIR } from "./repo-shelf.ts";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
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
	const dir = mkdtempSync(join(tmpdir(), "coding-concurrency-"));
	dirs.push(dir);
	const origin = join(dir, "origin.git");
	const seed = join(dir, "seed");
	mkdirSync(origin);
	mkdirSync(seed);
	await git(origin, "init", "--bare", "--initial-branch=main");
	await git(seed, "init", "--initial-branch=main");
	await identity(seed);
	await commit(seed, "README.md", "# Example\n\nAn example repository.\n");
	await git(seed, "remote", "add", "origin", origin);
	await git(seed, "push", "-u", "origin", "main");
	const shelf = new RepoShelf(join(dir, "shelf"), async (_repo, path) => {
		await git(dir, "clone", origin, path);
		await identity(path);
	});
	const clone = await shelf.add("sample/project");
	return { shelf, clone };
}
function gate<T = void>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const request = (
	extra: Partial<Omit<CodingJob, "id" | "startedAt" | "startHead">> = {},
) => ({
	repo: "sample/project",
	task: "Implement the contract",
	channel: "test:room" as const,
	model: "faux/worker",
	thinking: "off" as const,
	skillFiles: [],
	...extra,
});
const OWNER_STARTER = {
	channel: "test:room" as const,
	speaker: { id: "owner", principalId: "p-owner", tier: "owner" as const },
};
function desk(
	options: Partial<CodingDeskOptions> &
		Pick<CodingDeskOptions, "shelf" | "worker">,
) {
	const results: CodingResult[] = [];
	const instance = new CodingDesk({
		logger: silentLogger(),
		deliver: async (result) => {
			results.push(result);
		},
		...options,
	});
	stops.push(() => instance.stop());
	return { desk: instance, results };
}

test("two workers on one repository work in their own worktrees and both merge", async () => {
	const { shelf, clone } = await fixture();
	const bothStarted = gate();
	const release = gate();
	const dirs: string[] = [];
	const { desk: coding, results } = desk({
		shelf,
		worker: {
			run: async (job) => {
				dirs.push(job.dir);
				if (dirs.length === 2) bothStarted.resolve();
				await release.promise;
				await commit(job.dir, `file-${job.id}.txt`, `job ${job.id}\n`);
				return `done ${job.id}`;
			},
		},
	});
	await coding.start(request());
	await coding.start(request());
	await bothStarted.promise;
	expect(dirs[0]).not.toBe(dirs[1]);
	expect(dirs.every((dir) => dir.includes(`/${WORKTREES_DIR}/`))).toBe(true);
	// Running workers leave the clone free for a report.
	expect(() => coding.checkIdle("sample/project")).not.toThrow();
	expect(coding.busy()).toEqual([
		"Coding #1 in sample/project",
		"Coding #2 in sample/project",
	]);
	release.resolve();
	await coding.idle();
	expect(results.map((result) => result.integration?.status)).toEqual([
		"merged",
		"merged",
	]);
	expect(results.every((result) => result.commits.length === 1)).toBe(true);
	const log = await git(clone, "log", "--format=%s");
	expect(log).toContain("Write file-1.txt");
	expect(log).toContain("Write file-2.txt");
	expect(await git(clone, "status", "--porcelain")).toBe("");
	expect(await git(clone, "branch", "--list", "worker/*")).toBe("");
	expect(dirs.some((dir) => existsSync(dir))).toBe(false);
	expect(shelf.repos()).toEqual(["sample/project"]);
	expect(codingReport(results[0] as CodingResult, "now")).toContain(
		"Merged worker/",
	);
});

test("a conflicting worker keeps its branch and worktree, names the files, and leaves the clone clean", async () => {
	const { shelf, clone } = await fixture();
	const bothStarted = gate();
	const firstDone = gate();
	let started = 0;
	const { desk: coding, results } = desk({
		shelf,
		worker: {
			run: async (job) => {
				if (++started === 2) bothStarted.resolve();
				await bothStarted.promise;
				if (job.id === 2) await firstDone.promise;
				await commit(job.dir, "README.md", `# Rewritten by ${job.id}\n`);
				return `done ${job.id}`;
			},
		},
		deliver: async (result) => {
			results.push(result);
			if (result.job.id === 1) firstDone.resolve();
		},
	});
	await coding.start(request());
	await coding.start(request());
	await coding.idle();
	const [first, second] = results;
	expect(first?.integration?.status).toBe("merged");
	expect(second?.integration).toMatchObject({
		status: "conflict",
		branch: "worker/2",
		files: ["README.md"],
	});
	const kept = second?.integration?.status === "conflict" && second.integration;
	if (!kept) throw new Error("no conflict");
	expect(existsSync(kept.dir)).toBe(true);
	expect(await git(kept.dir, "status", "--porcelain")).toBe("");
	expect(await git(clone, "branch", "--list", "worker/2")).toContain(
		"worker/2",
	);
	expect(await git(clone, "status", "--porcelain")).toBe("");
	expect(existsSync(join(clone, ".git", "rebase-merge"))).toBe(false);
	expect(await git(clone, "log", "-1", "--format=%s")).toBe("Write README.md");
	expect(second?.state?.branch).toBe("worker/2");
	expect(second?.commits).toHaveLength(1);
	const report = codingReport(second as CodingResult, "now");
	expect(report).toContain("conflicted in:\nREADME.md");
	expect(report).toContain(kept.dir);
	// A later run with the same number gets a branch of its own.
	expect((await shelf.addWorktree("sample/project", 2)).branch).toBe(
		"worker/2-2",
	);
});

test("a clone with uncommitted changes at integration is left alone and the branch kept", async () => {
	const { shelf, clone } = await fixture();
	const { desk: coding, results } = desk({
		shelf,
		worker: {
			run: async (job) => {
				await commit(job.dir, "work.txt", "work\n");
				writeFileSync(join(clone, "README.md"), "edited by hand\n");
				return "done";
			},
		},
	});
	await coding.start(request());
	await coding.idle();
	expect(results[0]?.integration).toMatchObject({
		status: "refused",
		branch: "worker/1",
		reason: expect.stringContaining("uncommitted changes"),
	});
	expect(await git(clone, "status", "--porcelain")).toBe("M README.md");
	expect(await git(clone, "log", "-1", "--format=%s")).toBe("Write README.md");
});

test("a worker that commits nothing leaves no worktree or branch behind", async () => {
	const { shelf, clone } = await fixture();
	let dir = "";
	const { desk: coding, results } = desk({
		shelf,
		worker: {
			run: async (job) => {
				dir = job.dir;
				return "nothing to do";
			},
		},
	});
	await coding.start(request());
	await coding.idle();
	expect(results[0]?.integration).toEqual({ status: "nothing" });
	expect(existsSync(dir)).toBe(false);
	expect(await git(clone, "worktree", "list")).not.toContain(WORKTREES_DIR);
	expect(await git(clone, "branch", "--list", "worker/*")).toBe("");
	expect(
		readdirSync(join(shelf.dir, WORKTREES_DIR, "sample", "project")),
	).toEqual([]);
});

test("past the host-wide cap tasks queue in order, start as slots free, and a full queue refuses", async () => {
	const { shelf } = await fixture();
	const order: number[] = [];
	const releases = new Map<number, () => void>();
	const startedJob = new Map<number, ReturnType<typeof gate>>();
	for (const id of [1, 2, 3]) startedJob.set(id, gate());
	const { desk: coding, results } = desk({
		shelf,
		maxWorkers: 1,
		maxQueued: 2,
		worker: {
			run: async (job) => {
				order.push(job.id);
				startedJob.get(job.id)?.resolve(undefined);
				await new Promise<void>((done) => releases.set(job.id, done));
				return `done ${job.id}`;
			},
		},
	});
	const first = await coding.start(request());
	const second = await coding.start(request({ channel: "test:other" }));
	const third = await coding.start(request());
	expect(first.queuePosition).toBeUndefined();
	expect([second.queuePosition, third.queuePosition]).toEqual([1, 2]);
	await expect(coding.start(request())).rejects.toThrow(
		"All 1 coding workers are busy and 2 tasks are already waiting",
	);
	await startedJob.get(1)?.promise;
	expect(coding.runningChannels()).toEqual(["test:room"]);
	expect(coding.queuedChannels()).toEqual(["test:other", "test:room"]);
	expect(coding.busy()).toEqual([
		"Coding #1 in sample/project",
		"Coding #2 in sample/project, queued (position 1)",
		"Coding #3 in sample/project, queued (position 2)",
	]);
	releases.get(1)?.();
	await startedJob.get(2)?.promise;
	expect(coding.runningChannels()).toEqual(["test:other"]);
	releases.get(2)?.();
	await startedJob.get(3)?.promise;
	releases.get(3)?.();
	await coding.idle();
	expect(order).toEqual([1, 2, 3]);
	expect(results.map((result) => result.job.id)).toEqual([1, 2, 3]);
	const options = {
		shelf,
		logger: silentLogger(),
		deliver: async () => {},
		worker: { run: async () => "" },
	};
	expect(() => new CodingDesk({ ...options, maxWorkers: 0 })).toThrow(
		"maxWorkers",
	);
	expect(() => new CodingDesk({ ...options, maxQueued: -1 })).toThrow(
		"maxQueued",
	);
	expect(
		() => new CodingDesk({ ...options, autonomy: { longRunningMaxMs: 0 } }),
	).toThrow("longRunningMaxMs");
});

test("a stop drops queued tasks with a notice and waits only for the running worker", async () => {
	const { shelf } = await fixture();
	const ran: number[] = [];
	const running = gate();
	const { desk: coding, results } = desk({
		shelf,
		maxWorkers: 1,
		worker: {
			run: async (job, signal) => {
				ran.push(job.id);
				running.resolve();
				await new Promise<void>((_done, reject) =>
					signal.addEventListener("abort", () => reject(new Error("stop")), {
						once: true,
					}),
				);
				return "never";
			},
		},
	});
	await coding.start(request());
	await coding.start(request());
	await running.promise;
	await coding.stop();
	expect(ran).toEqual([1]);
	const byId = new Map(results.map((result) => [result.job.id, result]));
	expect(byId.get(1)?.outcome).toEqual({
		ok: false,
		error: "the worker was stopped",
	});
	expect(byId.get(2)?.outcome).toMatchObject({
		ok: false,
		error: expect.stringContaining("before this queued task started"),
	});
	expect(coding.busy()).toEqual([]);
	await expect(coding.start(request())).rejects.toThrow("stopped");
});

test("integration blocks shipping, and waits for a report in progress", async () => {
	const { shelf } = await fixture();
	const finishShip = gate<string>();
	const workerDone = gate();
	const { desk: coding, results } = desk({
		shelf,
		worker: {
			run: async (job) => {
				await commit(job.dir, "late.txt", "late\n");
				workerDone.resolve();
				return "done";
			},
		},
	});
	const shipping = coding.ship("sample/project", () => finishShip.promise);
	expect(coding.shipping("sample/project")).toBe(true);
	await expect(
		coding.ship("sample/project", async () => "again"),
	).rejects.toThrow("already in progress");
	await coding.start(request());
	await workerDone.promise;
	await Bun.sleep(50);
	// The integration waits for the report instead of moving the clone under it.
	expect(results).toHaveLength(0);
	finishShip.resolve("reported");
	expect(await shipping).toBe("reported");
	await coding.idle();
	expect(results[0]?.integration?.status).toBe("merged");
});

function yoloDesk(
	shelf: RepoShelf,
	calls: HeldCall[],
	mode: { yolo: boolean; longRunning: boolean },
	extra: Partial<CodingDeskOptions> = {},
) {
	const cards: string[] = [];
	const logged: AutoApproval[] = [];
	const answers: string[] = [];
	const prompts: OwnerPrompts = {
		confirm: async (_title, card) => {
			cards.push(card);
			return "declined";
		},
		ask: async () => undefined,
	};
	const made = desk({
		shelf,
		prompts: () => prompts,
		modes: {
			peek: () => mode,
			autoApproved: (entry) => logged.push(entry),
		},
		autonomy: { yolo: { allow: [], card: ["shell.push"] } },
		worker: {
			run: async (_job, _signal, review) => {
				for (const call of calls) answers.push(await review(call));
				return "done";
			},
		},
		...extra,
	});
	return { ...made, cards, logged, answers };
}
const WRITE: HeldCall = {
	tool: "write",
	input: '{"path":"/elsewhere"}',
	action: "write /elsewhere",
	holdClasses: ["shell.write"],
};
const PUSH: HeldCall = {
	tool: "bash",
	input: '{"command":"git push"}',
	action: "push",
	holdClasses: ["shell.push"],
};
const UNCLASSED: HeldCall = {
	tool: "bash",
	input: '{"command":"mystery"}',
	action: "something unknown",
};

test("the starter's yolo mode approves a call it allows and still cards a carded or unclassed one", async () => {
	const { shelf } = await fixture();
	const mode = { yolo: true, longRunning: false };
	const yolo = yoloDesk(shelf, [WRITE, PUSH, UNCLASSED], mode);
	await yolo.desk.start(request({ starter: OWNER_STARTER }));
	await yolo.desk.idle();
	expect(yolo.answers).toEqual(["approved", "declined", "declined"]);
	expect(yolo.cards).toHaveLength(2);
	expect(yolo.logged).toMatchObject([
		{
			channel: "test:room",
			tool: "write",
			classes: ["shell.write"],
			principalId: "p-owner",
		},
	]);
	const result = yolo.results[0] as CodingResult;
	expect(result.autoApproved).toEqual([
		'write /elsewhere: write {"path":"/elsewhere"}',
	]);
	expect(codingReport(result, "now")).toContain(
		"### Approved by yolo mode\n\nwrite /elsewhere",
	);
});

test("yolo is read live, and acts only for an owner's turn other than the host's", async () => {
	const { shelf } = await fixture();
	const mode = { yolo: false, longRunning: false };
	const toggled = yoloDesk(shelf, [WRITE], mode, {
		prompts: () => ({
			confirm: async () => {
				// The owner switches yolo on while the first card is open.
				mode.yolo = true;
				return "declined";
			},
			ask: async () => undefined,
		}),
		worker: {
			run: async (_job, _signal, review) =>
				`${await review(WRITE)} ${await review(WRITE)}`,
		},
	});
	await toggled.desk.start(request({ starter: OWNER_STARTER }));
	await toggled.desk.idle();
	expect(toggled.results[0]?.outcome).toEqual({
		ok: true,
		report: "declined approved",
	});
	for (const speaker of [
		{ id: "member", principalId: "p-member", tier: "member" as const },
		{ id: "host", principalId: SYSTEM_PRINCIPAL, tier: "owner" as const },
	]) {
		const other = yoloDesk(shelf, [WRITE], { yolo: true, longRunning: false });
		await other.desk.start(
			request({ starter: { channel: "test:room", speaker } }),
		);
		await other.desk.idle();
		expect(other.answers).toEqual(["declined"]);
		expect(other.logged).toEqual([]);
	}
	const noStarter = yoloDesk(shelf, [WRITE], { yolo: true, longRunning: true });
	await noStarter.desk.start(request());
	await noStarter.desk.idle();
	expect(noStarter.answers).toEqual(["declined"]);
});

test("the starter's long-running mode extends the worker's time, up to the host's cap", async () => {
	const { shelf } = await fixture();
	const run = async (longRunning: boolean, longRunningMaxMs: number) => {
		const made = desk({
			shelf,
			timeoutMs: 60,
			modes: { peek: () => ({ yolo: false, longRunning }) },
			autonomy: { longRunningMaxMs },
			worker: {
				run: async (_job, signal) => {
					await Promise.race([
						Bun.sleep(250),
						new Promise((resolve) =>
							signal.addEventListener("abort", resolve, { once: true }),
						),
					]);
					if (signal.aborted) throw new Error("stopped");
					return "finished";
				},
			},
		});
		await made.desk.start(request({ starter: OWNER_STARTER }));
		await made.desk.idle();
		return made.results[0]?.outcome;
	};
	expect(await run(true, 1_000)).toEqual({ ok: true, report: "finished" });
	expect(await run(false, 1_000)).toMatchObject({
		ok: false,
		error: expect.stringContaining("ran out of time"),
	});
	expect(await run(true, 120)).toMatchObject({
		ok: false,
		error: expect.stringContaining("ran out of time"),
	});
});
