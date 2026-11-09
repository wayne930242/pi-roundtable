import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SKILLS } from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import type { CodingJob, CodingResult } from "./coding-desk.ts";
import { coding } from "./coding-plugin.ts";
import { PiCodingWorker } from "./pi-coding-worker.ts";
import {
	FAUX_PROVIDER,
	gate,
	request,
	stops,
	surface,
} from "./testing/coding-fixture.ts";
import {
	change,
	fixture,
	git,
	identity,
	removeTemp,
	temp,
} from "./testing/repo-fixture.ts";

afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	removeTemp();
});

test("real out-of-process Pi worker requests host approval and cannot execute a refused call", async () => {
	const { shelf, dir } = await fixture();
	const repoDir = await shelf.add("sample/project");
	const agentDir = join(dir, "login");
	mkdirSync(agentDir);
	for (const answer of ["approved", "declined", "held"] as const) {
		const marker = join(repoDir, "..", "approval-marker.txt");
		rmSync(marker, { force: true });
		let reviewed = 0;
		const heard: string[] = [];
		const worker = new PiCodingWorker({ agentDir, packages: [FAUX_PROVIDER] });
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
			{
				messageEnd: (message) =>
					heard.push(`${message.role}:${message.stopReason}`),
				toolStart: (name) => heard.push(`tool:${name}`),
			},
		);
		expect(reviewed).toBe(1);
		// The session's progress crosses to the host: the tool call, then each assistant message.
		expect(heard).toEqual([
			"assistant:toolUse",
			"tool:write",
			"assistant:stop",
		]);
		expect(existsSync(marker)).toBe(answer === "approved");
		const pid = Number(report.match(/pid=(\d+)/)?.[1]);
		expect(pid).not.toBe(process.pid);
		expect(() => process.kill(pid, 0)).toThrow();
		if (answer !== "approved") expect(report).toContain("Do not retry");
	}
}, 60_000);

test("a worker is told its scratch dir, and a write inside it runs without asking the owner", async () => {
	const { shelf, dir } = await fixture();
	const repoDir = await shelf.add("sample/project");
	const agentDir = join(dir, "login");
	mkdirSync(agentDir);
	// The faux model writes next to the clone, which here is the scratch dir.
	const scratchDir = realpathSync(join(repoDir, ".."));
	const marker = join(scratchDir, "approval-marker.txt");
	rmSync(marker, { force: true });
	let reviewed = 0;
	const worker = new PiCodingWorker({
		agentDir,
		packages: [FAUX_PROVIDER],
		scratchDir,
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
		async () => {
			reviewed++;
			return "declined";
		},
	);
	expect(reviewed).toBe(0);
	expect(existsSync(marker)).toBe(true);
	// The worker is told where its scratch dir is, without the task having to say so.
	expect(report).toContain("scratchPrompt=true");
}, 30_000);

test("a host words what the worker reads when a call is declined or held", async () => {
	const { shelf, dir } = await fixture();
	const repoDir = await shelf.add("sample/project");
	const agentDir = join(dir, "login");
	mkdirSync(agentDir);
	for (const answer of ["declined", "held"] as const) {
		const worker = new PiCodingWorker({
			agentDir,
			packages: [FAUX_PROVIDER],
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
}, 60_000);

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
	// A name the hold refuses is held under the generic description, never let through.
	expect(
		harness.holds("repo_push", { repo: "sample/../escape", sha }, {}),
	).toBe("run repo_push");
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
