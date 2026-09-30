import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CORE = join(ROOT, "src/core");

/** The core's modules, tests and test helpers aside. */
function modules(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "testing" ? [] : modules(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
			? [path]
			: [];
	});
}

/** The packages a module imports, by their bare names. */
function packages(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return [
		...source.matchAll(/(?:from|import)\s*\(?\s*"([^."][^"]*)"/g),
	].flatMap((match) => (match[1] ? [match[1]] : []));
}

/** Services only the first consumer's deployment runs; the core must work without them. */
const PRIVATE = new RegExp(
	// Spelled in pieces so this test does not itself name the private services.
	["j" + "ev", "phoe" + "nix", "context" + "forge", "type" + "safe"].join("|"),
	"i",
);

describe("the public core", () => {
	test("imports no package of a private service", () => {
		const found = modules(CORE).flatMap((file) =>
			packages(file)
				.filter((name) => PRIVATE.test(name))
				.map((name) => `${relative(ROOT, file)} -> ${name}`),
		);
		expect(found).toEqual([]);
	});

	test("every module loads with no consumer configuration", () => {
		const imports = modules(CORE)
			.map((file) => `await import(${JSON.stringify(file)});`)
			.join("\n");
		const run = Bun.spawnSync({
			cmd: [process.execPath, "-e", imports],
			cwd: ROOT,
			// Only what a process needs to start; none of a consumer's variables.
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
			stderr: "pipe",
		});
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
	});
});
