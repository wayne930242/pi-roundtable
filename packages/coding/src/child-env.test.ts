import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerProcessEnv } from "./pi-coding-worker.ts";
import { RepoShelf } from "./repo-shelf.ts";
import { workerBash } from "./worker-entry.ts";

const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => {
	for (const name of Object.keys(process.env))
		if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "coding-env-"));
	dirs.push(dir);
	return dir;
}

/** The variable names and values of each `env` dump a fake program wrote to `log`. */
function dumps(log: string): Record<string, string>[] {
	return readFileSync(log, "utf8")
		.split("\n--\n")
		.filter((dump) => dump.trim())
		.map((dump) =>
			Object.fromEntries(
				dump
					.split("\n")
					.filter((line) => line.includes("="))
					.map((line) => [
						line.slice(0, line.indexOf("=")),
						line.slice(line.indexOf("=") + 1),
					]),
			),
		);
}

/** A bin dir with a `name` that logs its environment to `log` before it runs `then`. */
function logging(name: string, log: string, then: string): string {
	const bin = join(temp(), "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, name),
		`#!/bin/sh\nenv >> '${log}'\necho -- >> '${log}'\n${then}\n`,
	);
	chmodSync(join(bin, name), 0o755);
	return bin;
}

test("the worker process gets the whitelist, Pi's agent dir and workerEnv.pass only", () => {
	const env = workerProcessEnv(
		{
			PATH: "/usr/bin",
			HOME: "/home/u",
			PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
			CLAUDE_CODE_OAUTH_TOKEN: "oauth-fake",
			DISCORD_TOKEN: "discord-fake",
			GH_TOKEN: "gh-fake",
		},
		{ pass: ["CLAUDE_CODE_OAUTH_TOKEN"] },
		"/tmp/scratch",
	);
	expect(env).toEqual({
		PATH: "/usr/bin",
		HOME: "/home/u",
		PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
		CLAUDE_CODE_OAUTH_TOKEN: "oauth-fake",
		TMPDIR: "/tmp/scratch",
	});
});

test("the worker's bash drops the model credential the worker process holds", async () => {
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-fake-value";
	process.env.OPTED_IN = "yes";
	const dir = temp();
	const bash = workerBash(dir, dir, { pass: ["OPTED_IN"] });
	const result = await bash.execute(
		"call",
		{ command: "env | cut -d= -f1" },
		undefined,
		undefined,
		undefined as never,
	);
	const names = result.content
		.map((part) => ("text" in part ? part.text : ""))
		.join("")
		.split("\n");
	expect(names).toContain("PATH");
	expect(names).toContain("TMPDIR");
	expect(names).toContain("OPTED_IN");
	expect(names).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("a gh clone gets the host's GH_TOKEN, read when the shelf is made, and no other secret", async () => {
	const log = join(temp(), "gh.log");
	process.env.PATH = `${logging("gh", log, "exit 1")}:${process.env.PATH}`;
	process.env.GH_TOKEN = "host-token";
	process.env.FAKE_SECRET_KEY = "fake-secret";
	const shelf = new RepoShelf(join(temp(), "shelf"));
	process.env.GH_TOKEN = "changed-later";
	await expect(shelf.add("octocat/project")).rejects.toThrow();
	const [env] = dumps(log);
	expect(env?.GH_TOKEN).toBe("host-token");
	expect(env?.FAKE_SECRET_KEY).toBeUndefined();
});

test("git calls of the shelf get githubToken as GH_TOKEN, and no other secret", async () => {
	const dir = temp();
	const run = (cwd: string, ...args: string[]) =>
		Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], {
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
	const origin = join(dir, "origin.git");
	const seed = join(dir, "seed");
	mkdirSync(origin);
	mkdirSync(seed);
	run(origin, "init", "-q", "--bare", "--initial-branch=main");
	run(seed, "init", "-q", "--initial-branch=main");
	writeFileSync(join(seed, "README.md"), "# Example\n");
	run(seed, "add", "README.md");
	run(seed, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "1");
	run(seed, "push", "-q", origin, "main");
	const log = join(temp(), "git.log");
	process.env.PATH = `${logging("git", log, 'exec /usr/bin/git "$@"')}:${process.env.PATH}`;
	process.env.GH_TOKEN = "host-token";
	process.env.FAKE_SECRET_KEY = "fake-secret";
	const shelf = new RepoShelf(
		join(dir, "shelf"),
		async (_repo, path) => {
			run(dir, "clone", "-q", origin, path);
		},
		{ githubToken: () => "option-token" },
	);
	await shelf.add("octocat/project");
	await shelf.list(true);
	const calls = dumps(log);
	expect(calls.length).toBeGreaterThan(0);
	for (const env of calls) {
		expect(env.GH_TOKEN).toBe("option-token");
		expect(env.FAKE_SECRET_KEY).toBeUndefined();
	}
});
