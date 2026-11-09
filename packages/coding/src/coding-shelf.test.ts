import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OWNER_SPEAKER, testPlugin } from "pi-roundtable/testing";
import { coding } from "./coding-plugin.ts";
import { RepoShelf } from "./repo-shelf.ts";
import { REPO_TOOLS } from "./repo-tools.ts";
import { gate, stops, surface } from "./testing/coding-fixture.ts";
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
	expect(harness.tools).toEqual([...REPO_TOOLS]);
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
