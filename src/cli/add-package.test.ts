import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addPackage } from "./add-package.ts";
import { init } from "./init.ts";
import type { PackagePorts } from "./pi-packages.ts";
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

/** Ports that record each call and answer with `tools`, or fail as told. */
function fakePackages(
	tools: string[] | Error = ["web_search"],
	installed = true,
) {
	const calls: string[] = [];
	const ports: PackagePorts = {
		install: async (_cwd, spec) => {
			calls.push(`install ${spec}`);
			return { ok: installed, output: installed ? "" : "404 Not Found" };
		},
		tools: async (_cwd, name) => {
			calls.push(`tools ${name}`);
			if (tools instanceof Error) throw tools;
			return tools;
		},
	};
	return { ports, calls };
}

test("add package installs the spec, writes a plugin that loads it and selects its tools, and lists it", async () => {
	const dir = project();
	const { ports, calls } = fakePackages(["web_search", "fetch_content"]);
	const report = await addPackage({
		cwd: dir.path,
		spec: "pi-web-access@0.35.0",
		ports,
	});
	expect(report.ok).toBe(true);
	expect(calls).toEqual([
		"install pi-web-access@0.35.0",
		"tools pi-web-access",
	]);
	expect(report.tools).toEqual(["web_search", "fetch_content"]);
	expect(report.changed).toEqual([
		"package.json",
		"plugins/pi-web-access.ts",
		"plugins/pi-web-access.test.ts",
		"roundtable.config.ts",
	]);
	const plugin = read(dir.path, "plugins/pi-web-access.ts");
	expect(plugin).toContain("export const piWebAccess = definePlugin(");
	expect(plugin).toContain('piPackages: ["pi-web-access"]');
	expect(plugin).toContain(
		'const TOOLS: string[] = ["web_search", "fetch_content"];',
	);
	expect(plugin).toContain(
		"agentSelection: () => ({ tools: [...TOOLS], groups: [] })",
	);
	expect(plugin).toContain("requiredTools: TOOLS");
	// A tier here would clash with a built-in plugin that already gives one, such as web_search's.
	expect(plugin).not.toContain("\t\ttoolTiers:");
	expect(plugin).not.toMatch(/__[A-Z]+__/);
	expect(read(dir.path, "plugins/pi-web-access.test.ts")).toContain(
		'import { piWebAccess } from "./pi-web-access.ts"',
	);
	expect(read(dir.path, "roundtable.config.ts")).toContain(
		"plugins: [selfCompact, hello, piWebAccess]",
	);
});

test("a scoped package is named without its scope", async () => {
	const dir = project();
	const { ports } = fakePackages(["notes-search"]);
	const report = await addPackage({
		cwd: dir.path,
		spec: "@acme/pi-notes",
		ports,
	});
	expect(report.ok).toBe(true);
	const plugin = read(dir.path, "plugins/pi-notes.ts");
	expect(plugin).toContain('piPackages: ["@acme/pi-notes"]');
	expect(plugin).toContain('const TOOLS: string[] = ["notes-search"];');
});

test("a package that registers no tools still gets a plugin that loads it", async () => {
	const dir = project();
	const { ports } = fakePackages([]);
	const report = await addPackage({ cwd: dir.path, spec: "pi-quiet", ports });
	expect(report.ok).toBe(true);
	const plugin = read(dir.path, "plugins/pi-quiet.ts");
	expect(plugin).toContain("const TOOLS: string[] = [];");
});

test("add package refuses before installing a spec it cannot name a plugin after, changing nothing", async () => {
	const dir = project();
	const before = read(dir.path, "roundtable.config.ts");
	for (const spec of [
		"",
		"github:acme/pi-notes",
		"./local",
		"https://example.test/x.tgz",
		"Pi-Notes",
		"pi_notes",
	]) {
		const { ports, calls } = fakePackages();
		const report = await addPackage({ cwd: dir.path, spec, ports });
		expect(report.ok).toBe(false);
		expect(report.problems.join(" ")).toContain("by hand");
		expect(calls).toEqual([]);
	}
	expect(read(dir.path, "roundtable.config.ts")).toBe(before);
});

test("add package refuses an existing plugin file or a config it cannot edit before installing", async () => {
	const dir = project();
	dir.write("plugins/pi-notes.test.ts", "// mine");
	const taken = fakePackages();
	const report = await addPackage({
		cwd: dir.path,
		spec: "pi-notes",
		ports: taken.ports,
	});
	expect(report.ok).toBe(false);
	expect(report.problems.join(" ")).toContain("already exists");
	expect(taken.calls).toEqual([]);

	dir.write("roundtable.config.ts", "export default buildConfig();\n");
	const unedited = fakePackages();
	const second = await addPackage({
		cwd: dir.path,
		spec: "pi-other",
		ports: unedited.ports,
	});
	expect(second.ok).toBe(false);
	expect(second.problems.join(" ")).toContain("cannot find the plugin list");
	expect(unedited.calls).toEqual([]);
});

test("add package outside a project says where it looked and installs nothing", async () => {
	const dir = tempDir();
	dirs.push(dir);
	const { ports, calls } = fakePackages();
	const report = await addPackage({ cwd: dir.path, spec: "pi-notes", ports });
	expect(report.ok).toBe(false);
	expect(report.problems.join(" ")).toContain("roundtable.config.ts is not in");
	expect(calls).toEqual([]);
});

test("a failed install writes nothing and shows bun's output", async () => {
	const dir = project();
	const before = read(dir.path, "roundtable.config.ts");
	const { ports, calls } = fakePackages(["x"], false);
	const report = await addPackage({ cwd: dir.path, spec: "pi-nope", ports });
	expect(report.ok).toBe(false);
	expect(report.problems).toEqual([
		"bun add pi-nope failed; nothing was written.",
		"404 Not Found",
	]);
	expect(calls).toEqual(["install pi-nope"]);
	expect(existsSync(join(dir.path, "plugins/pi-nope.ts"))).toBe(false);
	expect(read(dir.path, "roundtable.config.ts")).toBe(before);
});

test("a package that fails to load writes no plugin and says how to uninstall it", async () => {
	const dir = project();
	const before = read(dir.path, "roundtable.config.ts");
	const { ports } = fakePackages(
		new Error("pi-broken has no Pi extension: it names none."),
	);
	const report = await addPackage({ cwd: dir.path, spec: "pi-broken", ports });
	expect(report.ok).toBe(false);
	expect(report.changed).toEqual(["package.json"]);
	expect(report.problems.join(" ")).toContain("has no Pi extension");
	expect(report.problems.join(" ")).toContain("bun remove pi-broken");
	expect(existsSync(join(dir.path, "plugins/pi-broken.ts"))).toBe(false);
	expect(read(dir.path, "roundtable.config.ts")).toBe(before);
});
