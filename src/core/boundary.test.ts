import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CORE = join(ROOT, "src/core");

function coreFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return coreFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** Relative imports of a file, as repository paths. */
function localImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return [...source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)].map((match) =>
		relative(ROOT, resolve(dirname(file), match[1] ?? "")),
	);
}

describe("core boundary", () => {
	test("the core imports only itself", () => {
		const outside = coreFiles(CORE).flatMap((file) =>
			localImports(file)
				.filter((path) => !path.startsWith("src/core/"))
				.map((path) => `${relative(ROOT, file)} -> ${path}`),
		);
		expect(outside).toEqual([]);
	});

	test("the core never imports a consumer's plugins", () => {
		const consumers = readdirSync(join(ROOT, "src"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name !== "core")
			.map((entry) => `src/${entry.name}/`);
		const found = coreFiles(CORE).flatMap((file) =>
			localImports(file).filter((path) =>
				consumers.some((prefix) => path.startsWith(prefix)),
			),
		);
		expect(found).toEqual([]);
	});
});
