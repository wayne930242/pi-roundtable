import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addPackage } from "./add-package.ts";
import { addPlugin } from "./add-plugin.ts";
import { init } from "./init.ts";
import { linkCheckout, tempDir } from "./testing/fixtures.ts";

const ROOT = resolve(import.meta.dir, "../..");
const TSC = join(ROOT, "node_modules/.bin/tsc");
const BIOME = join(ROOT, "node_modules/.bin/biome");

function run(cwd: string, cmd: string[]): { ok: boolean; output: string } {
	const result = Bun.spawnSync(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CI: "" },
	});
	return {
		ok: result.exitCode === 0,
		output: `${result.stdout.toString()}${result.stderr.toString()}`,
	};
}

const dir = tempDir("roundtable-template-");
const bun = { version: Bun.version, required: ">=1.3.0" };
const check = (label: string) => {
	const typecheck = run(dir.path, [TSC, "--noEmit"]);
	const test = run(dir.path, ["bun", "test"]);
	const lint = run(dir.path, [BIOME, "check", "."]);
	return { label, typecheck, test, lint };
};

let fresh: ReturnType<typeof check>;
let grown: ReturnType<typeof check>;
let official: ReturnType<typeof check>;
let packaged: ReturnType<typeof check>;

/** Three Pi packages: tools too many for one line, one short line, and none; the config's plugin list then passes one line. */
const PACKAGES: Record<string, string[]> = {
	"pi-web-access": [
		"web_search",
		"source_check",
		"fetch_content",
		"get_search_content",
		"web_enable",
	],
	"@acme/pi-notes": ["notes-search"],
	"pi-quiet": [],
};

beforeAll(async () => {
	const report = init({ cwd: dir.path, bun, version: "0.1.0" });
	if (!report.ok) throw new Error(report.problems.join("\n"));
	linkCheckout(dir.path);
	fresh = check("fresh");
	const added = addPlugin({ cwd: dir.path, name: "second-plugin" });
	if (!added.ok) throw new Error(added.problems.join("\n"));
	grown = check("after add plugin");
	for (const name of ["codex-images", "dice", "release-notice"]) {
		const copied = addPlugin({ cwd: dir.path, name });
		if (!copied.ok) throw new Error(copied.problems.join("\n"));
	}
	official = check("after adding the official plugins");
	for (const spec of Object.keys(PACKAGES)) {
		const added = await addPackage({
			cwd: dir.path,
			spec,
			ports: {
				install: async () => ({ ok: true, output: "" }),
				tools: async (_cwd, name) => PACKAGES[name] ?? [],
			},
		});
		if (!added.ok) throw new Error(added.problems.join("\n"));
	}
	packaged = check("after adding Pi packages");
}, 240_000);
afterAll(() => dir.done());

describe("every template rendered into one project", () => {
	test("typechecks with no edits", () => {
		expect(fresh.typecheck.output).toBe("");
		expect(fresh.typecheck.ok).toBe(true);
	});
	test("passes its own test with no edits", () => {
		expect(fresh.test.output).toContain("1 pass");
		expect(fresh.test.ok).toBe(true);
	});
	test("passes the linter it ships with", () => {
		expect(fresh.lint.output).toContain("No fixes applied");
		expect(fresh.lint.ok).toBe(true);
	});
	test("still typechecks, tests, and lints after `add plugin`", () => {
		expect(grown.typecheck.output).toBe("");
		expect(grown.test.output).toContain("2 pass");
		expect(grown.lint.output).toContain("No fixes applied");
		expect(grown.typecheck.ok && grown.test.ok && grown.lint.ok).toBe(true);
	});
	test("still typechecks, tests, and lints after the official plugins are added", () => {
		expect(official.typecheck.output).toBe("");
		expect(official.test.output).toContain("25 pass");
		expect(official.lint.output).toContain("No fixes applied");
		expect(official.typecheck.ok && official.test.ok && official.lint.ok).toBe(
			true,
		);
	});
	test("still typechecks, tests, and lints after `add package`", () => {
		expect(packaged.typecheck.output).toBe("");
		expect(packaged.test.output).toContain("28 pass");
		expect(packaged.lint.output).toContain("No fixes applied");
		expect(packaged.typecheck.ok && packaged.test.ok && packaged.lint.ok).toBe(
			true,
		);
	});
});

test("the generated team's first agent sits in the entry channel, which makes it the coordinator", () => {
	const printed = Bun.spawnSync(
		[
			"bun",
			"-e",
			'import { agents } from "./agents.ts"; console.log(JSON.stringify(agents[0]))',
		],
		{
			cwd: dir.path,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, DISCORD_ENTRY_CHANNEL_ID: "9001" },
		},
	);
	expect(printed.exitCode).toBe(0);
	expect(JSON.parse(printed.stdout.toString())).toMatchObject({
		name: "guide",
		channelId: "9001",
	});
});

test("the generated project's pinned tools match this package's own", () => {
	const project = JSON.parse(
		readFileSync(join(dir.path, "package.json"), "utf8"),
	) as {
		dependencies: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	const own = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
		dependencies: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	expect(project.dependencies.typebox).toBe(own.dependencies.typebox);
	for (const name of ["typescript", "@biomejs/biome", "@types/bun"])
		expect(project.devDependencies[name]).toBe(own.devDependencies[name]);
});

test("no template file is hidden from git by an ignore rule, which would leave a clone unable to init", () => {
	const inRepository = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	// The exported public tree is not a checkout; its own ignore file is packaging/.gitignore.
	if (inRepository.exitCode !== 0) return;
	const ignored = Bun.spawnSync(
		[
			"git",
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"templates",
		],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
	);
	expect(ignored.stdout.toString().trim()).toBe("");
});
