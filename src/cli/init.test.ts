import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_INSTALL_PAGE } from "./checks/bun.ts";
import { init } from "./init.ts";
import { tempDir } from "./testing/fixtures.ts";

const dirs: ReturnType<typeof tempDir>[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.done();
});
const temp = () => {
	const dir = tempDir();
	dirs.push(dir);
	return dir;
};

const bun = { version: "1.3.10", required: ">=1.3.0" };

const everything = (dir: string): string[] =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort();

test("init writes the skeleton and the hello plugin, pins the version, and prints three next steps", () => {
	const dir = temp();
	const report = init({ cwd: dir.path, dir: "bot", bun, version: "1.2.3" });
	expect(report.ok).toBe(true);
	expect(everything(join(dir.path, "bot"))).toEqual(
		[
			".env.example",
			".gitignore",
			"README.md",
			"agents.ts",
			"biome.json",
			"docker-compose.yml",
			"package.json",
			"persona/shared.md",
			"plugins/hello.test.ts",
			"plugins/hello.ts",
			"roundtable.config.ts",
			"tsconfig.json",
		].sort(),
	);
	expect([...report.created].sort()).toEqual(everything(join(dir.path, "bot")));
	const manifest = JSON.parse(
		readFileSync(join(dir.path, "bot/package.json"), "utf8"),
	) as { name: string; dependencies: Record<string, string> };
	expect(manifest.name).toBe("bot");
	expect(manifest.dependencies["pi-roundtable"]).toBe("1.2.3");
	expect(report.nextSteps).toHaveLength(3);
	expect(report.nextSteps[0]).toStartWith("cd bot && bun install");
	expect(report.nextSteps[1]).toContain("roundtable doctor");
	expect(report.nextSteps[2]).toContain("roundtable start");
	const hello = readFileSync(join(dir.path, "bot/plugins/hello.ts"), "utf8");
	expect(hello).toContain('name: "hello"');
	expect(hello).toContain("hello_greet");
});

test("init in the current directory needs no cd, and no file keeps a placeholder", () => {
	const dir = temp();
	const report = init({ cwd: dir.path, bun, version: "1.2.3" });
	expect(report.ok).toBe(true);
	expect(report.nextSteps[0]).toStartWith("bun install");
	for (const path of everything(dir.path))
		expect(readFileSync(join(dir.path, path), "utf8")).not.toMatch(
			/__[A-Z]+__/,
		);
});

test("init refuses before writing anything when Bun is missing, naming the install page", () => {
	const dir = temp();
	const report = init({
		cwd: dir.path,
		bun: { version: undefined, required: ">=1.3.0" },
		version: "1.2.3",
	});
	expect(report.ok).toBe(false);
	expect(report.problems.join("\n")).toContain(BUN_INSTALL_PAGE);
	expect(everything(dir.path)).toEqual([]);
});

test("init refuses when Bun is older than engines.bun, naming both versions and the page", () => {
	const dir = temp();
	const report = init({
		cwd: dir.path,
		bun: { version: "1.2.9", required: ">=1.3.0" },
		version: "1.2.3",
	});
	expect(report.ok).toBe(false);
	const text = report.problems.join("\n");
	expect(text).toContain("1.2.9");
	expect(text).toContain(">=1.3.0");
	expect(text).toContain(BUN_INSTALL_PAGE);
	expect(everything(dir.path)).toEqual([]);
});

test("init refuses, listing every file that exists, and writes nothing", () => {
	const dir = temp();
	dir.write("roundtable.config.ts", "// mine");
	dir.write("plugins/hello.ts", "// mine");
	const before = everything(dir.path);
	const report = init({ cwd: dir.path, bun, version: "1.2.3" });
	expect(report.ok).toBe(false);
	const text = report.problems.join("\n");
	expect(text).toContain("roundtable.config.ts");
	expect(text).toContain("plugins/hello.ts");
	expect(text).not.toContain("package.json");
	expect(everything(dir.path)).toEqual(before);
	expect(readFileSync(join(dir.path, "roundtable.config.ts"), "utf8")).toBe(
		"// mine",
	);
	expect(existsSync(join(dir.path, "package.json"))).toBe(false);
});

test("the generated configuration reads credentials from the environment and holds none", () => {
	const dir = temp();
	init({ cwd: dir.path, bun, version: "1.2.3" });
	const config = readFileSync(join(dir.path, "roundtable.config.ts"), "utf8");
	expect(config).toContain("process.env");
	for (const key of ["DISCORD_TOKEN", "DATABASE_URL", "OWNER_ID", "MODEL"])
		expect(config).toContain(`env("${key}")`);
	expect(config).not.toMatch(/\d{15,}/);
	expect(config).not.toMatch(/token:\s*"/);
	expect(readFileSync(join(dir.path, ".gitignore"), "utf8")).toContain(".env");
});
