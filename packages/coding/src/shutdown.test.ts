import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelKey, Roundtable } from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import {
	CodingDesk,
	type CodingJob,
	type CodingResult,
	type CodingWorker,
} from "./coding-desk.ts";
import { CODING, coding } from "./coding-plugin.ts";
import { RepoShelf } from "./repo-shelf.ts";

const dirs: string[] = [];
const stops: (() => Promise<unknown>)[] = [];
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
	const dir = mkdtempSync(join(tmpdir(), "coding-shutdown-"));
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
function gate<T = void>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const request = (extra: Partial<CodingJob> = {}) => ({
	repo: "sample/project",
	task: "Implement the contract",
	channel: "test:room" as const,
	model: "faux/worker",
	thinking: "off" as const,
	skillFiles: [],
	...extra,
});
/** A worker that commits once, then waits until told to stop. */
function waitingWorker(): { worker: CodingWorker; committed: Promise<void> } {
	const committed = gate();
	return {
		committed: committed.promise,
		worker: {
			run: async (job, signal) => {
				if (job.id === 1) {
					await commit(job.dir, "work.txt", "partial\n");
					committed.resolve();
				}
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					signal.addEventListener("abort", () => resolve());
				});
				return "stopped";
			},
		},
	};
}

test("the host's shutdown tells running workers to stop, drops the queued tasks with a report, and starts nothing more", async () => {
	const { shelf, clone } = await fixture();
	const work = waitingWorker();
	const results: CodingResult[] = [];
	const desk = new CodingDesk({
		shelf,
		worker: work.worker,
		maxWorkers: 1,
		logger: silentLogger(),
		deliver: async (result) => {
			results.push(result);
		},
	});
	stops.push(() => desk.stop());
	const before = await git(clone, "rev-parse", "HEAD");
	await desk.start(request());
	await desk.start(request());
	await work.committed;
	expect(desk.interrupt()).toBe(true);
	await desk.idle();
	const stopped = results.find(({ job }) => job.id === 1);
	// The report names where the work is kept, and says why it was not merged.
	expect(stopped?.outcome).toMatchObject({ ok: false });
	expect(stopped?.outcome).toHaveProperty("error");
	if (stopped?.outcome.ok !== false) throw new Error("expected a stopped task");
	expect(stopped.outcome.error).toContain("host");
	expect(stopped.integration).toMatchObject({ status: "refused" });
	if (stopped.integration?.status !== "refused") throw new Error("no branch");
	expect(stopped.integration.reason).toContain("host");
	expect(existsSync(stopped.integration.dir)).toBe(true);
	expect(stopped.commits).toHaveLength(1);
	expect(await git(clone, "rev-parse", "HEAD")).toBe(before);
	// The queued task never ran, and says so.
	const dropped = results.find(({ job }) => job.id === 2);
	expect(dropped?.outcome).toMatchObject({ ok: false });
	expect(dropped?.integration).toBeUndefined();
	await expect(desk.start(request())).rejects.toThrow("stopped");
	expect(desk.interrupt()).toBe(false);
});

test("a task counts as busy while it runs, while it waits, and until its report is delivered", async () => {
	const { shelf } = await fixture();
	const report = gate();
	const finish = gate();
	const desk = new CodingDesk({
		shelf,
		worker: {
			run: async (_job, _signal) => {
				await finish.promise;
				return "Done.";
			},
		},
		maxWorkers: 1,
		logger: silentLogger(),
		deliver: () => report.promise,
	});
	stops.push(async () => {
		finish.resolve();
		report.resolve();
		await desk.stop();
	});
	await desk.start(request({ channel: "test:one" }));
	await desk.start(request({ channel: "test:two" }));
	const channels = (): ChannelKey[] => desk.busyChannels();
	expect(channels()).toEqual(["test:one", "test:two"]);
	finish.resolve();
	// The first worker is done and its slot went to the second, but its report is still going out.
	while (desk.workers().running === 0 && desk.workers().queued === 1)
		await Bun.sleep(1);
	expect(channels()).toContain("test:one");
	report.resolve();
	await desk.idle();
	expect(channels()).toEqual([]);
});

test("the plugin delivers a report through the queue's drain lane, so a report of work that ends during the drain gets through", async () => {
	const { shelf } = await fixture();
	const work = waitingWorker();
	const seen: string[] = [];
	let queueTask: ((channel: ChannelKey) => Promise<string>) | undefined;
	let desk: CodingDesk | undefined;
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 30, abortGraceMs: 2_000 },
		},
		[
			coding({
				shelfDir: shelf.dir,
				model: "faux/default",
				worker: work.worker,
				onResult: async () => {
					// What a host's report path does: a turn in the channel's queue.
					const ran = await queueTask?.("test:room");
					seen.push(ran ?? "no queue");
				},
			}),
			{
				name: "probe",
				setup: (context) => {
					queueTask = (channel) =>
						context.queue.run(channel, async () => "report turn");
					return {
						services: [
							{
								name: "probe",
								start: () => {
									desk = context.services.get(CODING).desk;
								},
							},
						],
					};
				},
			},
		],
	);
	stops.push(() => roundtable.shutdown("test"));
	await roundtable.run();
	if (!desk) throw new Error("the desk was not provided");
	await desk.start(request());
	await work.committed;
	// The limit passes while the worker runs: it is told to stop, reports, and the report gets through.
	expect(await roundtable.shutdown("SIGTERM")).toBe(0);
	expect(seen).toEqual(["report turn"]);
});
