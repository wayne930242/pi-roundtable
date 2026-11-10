import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testPlugin } from "pi-roundtable/testing";
import type { CodingJob } from "./coding-desk.ts";
import { coding } from "./coding-plugin.ts";
import { RepoShelf } from "./repo-shelf.ts";
import { REPO_TOOLS } from "./repo-tools.ts";
import { DEFAULT_TOOL_TEXT } from "./tool-text.ts";

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
/** A shelf directory whose clone, `sample/project`, comes from a bare origin. */
async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "coding-tool-text-"));
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
	const shelfDir = join(dir, "shelf");
	const clone = async (_repo: string, path: string) => {
		await git(dir, "clone", origin, path);
		await identity(path);
	};
	return { shelfDir, clone, shelf: new RepoShelf(shelfDir, clone) };
}
type Harness = Awaited<ReturnType<typeof testPlugin>>;
interface Registered {
	description: string;
	parameters: { properties: Record<string, { description?: string }> };
}
function definitions(harness: Harness) {
	const found: Record<string, Registered> = {};
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
			registerTool: (definition: Registered & { name: string }) => {
				found[definition.name] = definition;
			},
		} as never);
	}
	return found;
}
const OWNER = {
	speaker: {
		id: "o",
		name: "Olive",
		tier: "owner" as const,
		principalId: "p-o",
	},
};
/** A worker that waits until it is stopped. */
const idleWorker = {
	run: async (_job: CodingJob, signal: AbortSignal) => {
		await new Promise<void>((resolve) => {
			if (signal.aborted) resolve();
			signal.addEventListener("abort", () => resolve());
		});
		return "stopped";
	},
};

test("the default text names every repository tool and is what the model reads without an override", async () => {
	const { shelfDir } = await fixture();
	expect(Object.keys(DEFAULT_TOOL_TEXT).sort()).toEqual([...REPO_TOOLS].sort());
	const harness = await testPlugin(coding({ shelfDir, model: "faux/worker" }));
	stops.push(() => harness.stop());
	const tools = definitions(harness);
	for (const name of REPO_TOOLS) {
		const text = DEFAULT_TOOL_TEXT[name];
		expect(text.description.length).toBeGreaterThan(0);
		expect(tools[name]?.description).toBe(text.description);
		for (const [argument, description] of Object.entries(text.parameters))
			expect(tools[name]?.parameters.properties[argument]?.description).toBe(
				description,
			);
	}
});

test("a consumer words only what differs, composing on the defaults; the rest follows the package", async () => {
	const { shelfDir } = await fixture();
	const harness = await testPlugin(
		coding({
			shelfDir,
			model: "faux/worker",
			toolText: {
				repo_task: {
					description: `${DEFAULT_TOOL_TEXT.repo_task.description} Mind the owner's repositories.`,
					parameters: { ...DEFAULT_TOOL_TEXT.repo_task.parameters, task: "X" },
				},
			},
		}),
	);
	stops.push(() => harness.stop());
	const tools = definitions(harness);
	expect(tools.repo_task?.description).toBe(
		`${DEFAULT_TOOL_TEXT.repo_task.description} Mind the owner's repositories.`,
	);
	expect(tools.repo_task?.parameters.properties.task?.description).toBe("X");
	expect(tools.repo_task_cancel?.description).toBe(
		DEFAULT_TOOL_TEXT.repo_task_cancel.description,
	);
});

test("task, queue, list and report hooks receive the default text, so a consumer can append", async () => {
	const { shelfDir, clone } = await fixture();
	const seen: Record<string, unknown> = {};
	const harness = await testPlugin(
		coding({
			shelfDir,
			model: "faux/worker",
			maxWorkers: 1,
			clone,
			worker: idleWorker,
			onResult: async () => {},
			postChangeReport: async () => {},
			ownerRepos: ["sample/project"],
			presentation: {
				list: (_repos, _context, text) => {
					seen.list = text;
					return `${text}\nList tail`;
				},
				changeReport: (_report, _direct, text) => {
					seen.report = text;
					return { post: `${text.post}\nPost tail`, result: text.result };
				},
				taskStarted: (_job, _skipped, text) => {
					seen.started = text;
					return `${text} Started tail`;
				},
				taskQueued: (_job, _position, _skipped, text) => {
					seen.queued = text;
					return `${text} Queued tail`;
				},
			},
		}),
	);
	stops.push(() => harness.stop());
	await harness.runTool("repo_add", { repo: "sample/project" });
	const list = await harness.runTool("repo_list", {}, OWNER);
	expect(list).toEndWith("\nList tail");
	expect(seen.list).toContain("sample/project");
	expect(list).toBe(`${seen.list}\nList tail`);
	const first = await harness.runTool(
		"repo_task",
		{ repo: "sample/project", task: "One" },
		OWNER,
	);
	expect(seen.started).toContain("repo_task_cancel cancels it");
	expect(first).toBe(`${seen.started} Started tail`);
	const second = await harness.runTool(
		"repo_task",
		{ repo: "sample/project", task: "Two" },
		OWNER,
	);
	expect(seen.queued).toContain("repo_task_cancel cancels it");
	expect(second).toBe(`${seen.queued} Queued tail`);
});

test("the change report hook receives the default post and result", async () => {
	const { shelfDir, clone, shelf } = await fixture();
	const posts: string[] = [];
	let seen: { post: string; result: string } | undefined;
	const harness = await testPlugin(
		coding({
			shelfDir,
			model: "faux/worker",
			clone,
			postChangeReport: async (_turn, text) => {
				posts.push(text);
			},
			presentation: {
				changeReport: (_report, _direct, text) => {
					seen = text;
					return { post: `${text.post}\nPost tail`, result: text.result };
				},
			},
		}),
	);
	stops.push(() => harness.stop());
	await harness.runTool("repo_add", { repo: "sample/project" });
	await commit(shelf.dirOf("sample/project"), "change.txt", "changed\n");
	const result = await harness.runTool(
		"repo_change_report",
		{ repo: "sample/project" },
		OWNER,
	);
	expect(seen?.post).toContain("sample/project");
	expect(result).toBe(seen?.result ?? "missing");
	expect(posts).toEqual([`${seen?.post}\nPost tail`]);
});

test("the defaults cannot be written into, at any depth, and a host's spread of them still composes", () => {
	expect(Object.isFrozen(DEFAULT_TOOL_TEXT)).toBe(true);
	for (const text of Object.values(DEFAULT_TOOL_TEXT)) {
		expect(Object.isFrozen(text)).toBe(true);
		expect(Object.isFrozen(text.parameters)).toBe(true);
	}
	expect(() => {
		(DEFAULT_TOOL_TEXT.repo_task.parameters as Record<string, string>).repo =
			"x";
	}).toThrow();
	const own = {
		...DEFAULT_TOOL_TEXT.repo_task,
		parameters: { ...DEFAULT_TOOL_TEXT.repo_task.parameters },
	};
	own.parameters.repo = "Mine.";
	expect(own.parameters.repo).toBe("Mine.");
	expect(DEFAULT_TOOL_TEXT.repo_task.parameters.repo).not.toBe("Mine.");
});
