import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addPlugin } from "./add-plugin.ts";
import { init } from "./init.ts";
import { tempDir } from "./testing/fixtures.ts";

const dirs: ReturnType<typeof tempDir>[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.done();
});
const project = () => {
	const dir = tempDir();
	dirs.push(dir);
	init({
		cwd: dir.path,
		bun: { version: "1.3.10", required: ">=1.3.0" },
		version: "1.2.3",
	});
	return dir;
};
const read = (dir: string, file: string) =>
	readFileSync(join(dir, file), "utf8");

test("add plugin renders the plugin and its test from the hello template and lists it", () => {
	const dir = project();
	const report = addPlugin({ cwd: dir.path, name: "my-notes" });
	expect(report.ok).toBe(true);
	expect(report.changed).toEqual([
		"plugins/my-notes.ts",
		"plugins/my-notes.test.ts",
		"roundtable.config.ts",
	]);
	const plugin = read(dir.path, "plugins/my-notes.ts");
	expect(plugin).toContain("export const myNotes = definePlugin(");
	expect(plugin).toContain('name: "my-notes"');
	expect(plugin).toContain("my_notes_greet");
	expect(read(dir.path, "plugins/my-notes.test.ts")).toContain(
		'import { myNotes } from "./my-notes.ts"',
	);
	const config = read(dir.path, "roundtable.config.ts");
	expect(config).toContain('import { myNotes } from "./plugins/my-notes.ts";');
	expect(config).toContain("plugins: [hello, myNotes]");
});

test("a second plugin joins the first", () => {
	const dir = project();
	addPlugin({ cwd: dir.path, name: "alpha" });
	addPlugin({ cwd: dir.path, name: "beta" });
	expect(read(dir.path, "roundtable.config.ts")).toContain(
		"plugins: [hello, alpha, beta]",
	);
});

test("add plugin refuses a name that is not lowercase kebab-case, changing nothing", () => {
	const dir = project();
	const before = read(dir.path, "roundtable.config.ts");
	for (const name of [
		"MyNotes",
		"my_notes",
		"-a",
		"a--b",
		"1a",
		"",
		"a b",
		"../x",
	]) {
		const report = addPlugin({ cwd: dir.path, name });
		expect(report.ok).toBe(false);
		expect(report.problems.join(" ")).toContain("is not a plugin name");
	}
	expect(read(dir.path, "roundtable.config.ts")).toBe(before);
});

test("add plugin refuses an existing file and leaves the config alone", () => {
	const dir = project();
	const before = read(dir.path, "roundtable.config.ts");
	const report = addPlugin({ cwd: dir.path, name: "hello" });
	expect(report.ok).toBe(false);
	expect(report.problems.join(" ")).toContain("plugins/hello.ts");
	expect(report.problems.join(" ")).toContain("already");
	expect(read(dir.path, "roundtable.config.ts")).toBe(before);
	dir.write("plugins/mine.test.ts", "// mine");
	expect(addPlugin({ cwd: dir.path, name: "mine" }).ok).toBe(false);
	expect(existsSync(join(dir.path, "plugins/mine.ts"))).toBe(false);
});

test("add plugin refuses a config whose plugin list it cannot find, writing no plugin file", () => {
	const dir = project();
	dir.write("roundtable.config.ts", "export default buildConfig();\n");
	const report = addPlugin({ cwd: dir.path, name: "extra" });
	expect(report.ok).toBe(false);
	expect(report.problems.join(" ")).toContain("cannot find the plugin list");
	expect(existsSync(join(dir.path, "plugins/extra.ts"))).toBe(false);
	expect(existsSync(join(dir.path, "plugins/extra.test.ts"))).toBe(false);
	expect(read(dir.path, "roundtable.config.ts")).toBe(
		"export default buildConfig();\n",
	);
});

test("add plugin outside a project says where it looked", () => {
	const dir = tempDir();
	dirs.push(dir);
	const report = addPlugin({ cwd: dir.path, name: "extra" });
	expect(report.ok).toBe(false);
	expect(report.problems.join(" ")).toContain("roundtable.config.ts is not in");
});
