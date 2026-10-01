import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CliEnvironment, readPackage, runCli } from "./cli.ts";
import { fakePorts, tempDir, validConfig } from "./testing/fixtures.ts";

const dirs: ReturnType<typeof tempDir>[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.done();
});

function cli(overrides: Partial<CliEnvironment> = {}) {
	const dir = tempDir();
	dirs.push(dir);
	const out: string[] = [];
	const err: string[] = [];
	const launched: unknown[] = [];
	const io: CliEnvironment = {
		cwd: dir.path,
		env: {},
		bun: () => ({ version: "1.3.10", required: ">=1.3.0" }),
		version: () => "1.2.3",
		ports: fakePorts(),
		launch: async (defined) => void launched.push(defined),
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		...overrides,
	};
	return { io, out, err, launched, dir };
}

test("no command prints the usage and exits non-zero; help and --version exit zero", async () => {
	const none = cli();
	expect(await runCli([], none.io)).toBe(1);
	expect(none.out.join("\n")).toContain("roundtable init");
	expect(none.out.join("\n")).toContain(
		"codex-images and dice are reserved for the official plugins",
	);
	const help = cli();
	expect(await runCli(["--help"], help.io)).toBe(0);
	const version = cli();
	expect(await runCli(["--version"], version.io)).toBe(0);
	expect(version.out).toEqual(["1.2.3"]);
});

test("an unknown command or a wrong argument list prints the problem and exits non-zero", async () => {
	for (const argv of [
		["frobnicate"],
		["add"],
		["add", "plugin"],
		["add", "thing", "x"],
		["add", "plugin", "a", "b"],
		["init", "a", "b"],
		["doctor", "extra"],
		["start", "--reachable"],
	]) {
		const run = cli();
		expect(await runCli(argv, run.io)).toBe(1);
		expect(run.err.length).toBeGreaterThan(0);
	}
});

test("init prints what it created and the three next steps, and exits zero; a second run refuses", async () => {
	const run = cli();
	expect(await runCli(["init", "bot"], run.io)).toBe(0);
	const text = run.out.join("\n");
	expect(text).toContain("roundtable.config.ts");
	expect(text).toContain("1. cd bot && bun install");
	expect(text).toContain("3. bunx roundtable start");
	expect(existsSync(join(run.dir.path, "bot/plugins/hello.ts"))).toBe(true);
	const again = await runCli(["init", "bot"], run.io);
	expect(again).toBe(1);
	expect(run.err.join("\n")).toContain("already exist");
});

test("init on an old Bun refuses with the install page and creates nothing", async () => {
	const run = cli({ bun: () => ({ version: "1.0.0", required: ">=1.3.0" }) });
	expect(await runCli(["init"], run.io)).toBe(1);
	expect(run.err.join("\n")).toContain("https://bun.sh/docs/installation");
	expect(existsSync(join(run.dir.path, "package.json"))).toBe(false);
});

test("add plugin exits zero after init and non-zero on a bad name", async () => {
	const run = cli();
	await runCli(["init"], run.io);
	expect(await runCli(["add", "plugin", "notes"], run.io)).toBe(0);
	expect(
		readFileSync(join(run.dir.path, "roundtable.config.ts"), "utf8"),
	).toContain("plugins: [hello, notes]");
	expect(await runCli(["add", "plugin", "Bad_Name"], run.io)).toBe(1);
});

test("add plugin copies an official plugin by name, and refuses it a second time", async () => {
	const run = cli();
	await runCli(["init"], run.io);
	expect(await runCli(["add", "plugin", "dice"], run.io)).toBe(0);
	expect(run.out.join("\n")).toContain("plugins/dice.ts");
	expect(readFileSync(join(run.dir.path, "plugins/dice.ts"), "utf8")).toContain(
		'name: "roll_dice"',
	);
	expect(
		readFileSync(join(run.dir.path, "roundtable.config.ts"), "utf8"),
	).toContain("plugins: [hello, dice]");
	expect(await runCli(["add", "plugin", "dice"], run.io)).toBe(1);
	expect(run.err.join("\n")).toContain("already exist");
});

test("doctor exits non-zero when a check fails and zero when none does", async () => {
	const failing = cli({
		ports: fakePorts(validConfig, { login: async () => undefined }),
	});
	expect(await runCli(["doctor"], failing.io)).toBe(1);
	expect(failing.out.join("\n")).toContain("✗ model login");
});

test("start exits non-zero without launching when an offline check fails, and launches otherwise", async () => {
	const failing = cli({ ports: fakePorts({}) });
	expect(await runCli(["start"], failing.io)).toBe(1);
	expect(failing.launched).toEqual([]);
	expect(failing.err.join("\n")).toContain("✗ configuration");
	const working = cli();
	expect(await runCli(["start"], working.io)).toBe(0);
	expect(working.launched).toHaveLength(1);
});

test("readPackage reads the version and Bun range, and refuses a package.json without them", () => {
	const dir = tempDir();
	dirs.push(dir);
	dir.write(
		"package.json",
		JSON.stringify({ version: "0.1.0", engines: { bun: ">=1.3.0" } }),
	);
	expect(readPackage(dir.path)).toEqual({ version: "0.1.0", bun: ">=1.3.0" });
	dir.write("package.json", JSON.stringify({ name: "private" }));
	expect(() => readPackage(dir.path)).toThrow(
		"installed pi-roundtable package",
	);
	dir.write("package.json", "{ nope");
	expect(() => readPackage(dir.path)).toThrow("not valid JSON");
});
