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

	test("the core names no concept of one consumer", () => {
		// A word starting with one of these names a concept the core must not know: a consumer's
		// party channels, profile catalogue, connectors, or its web-research worker.
		const concept = /(?<![a-z])(party|profile|connector|sol-?worker)/i;
		// The only allowed lines are the agent panel's `/<root> profile` subcommand: a user-visible
		// command of the agent server that shows an agent's own profile, not a consumer's catalogue.
		const allowed: Record<string, string> = {
			"src/core/discord/agent-commands.ts":
				"`/<root> profile` opens an agent's panel",
			"src/core/discord/agent-panel.ts":
				"the agent panel factory builds `/<root> profile`'s panel",
			"src/core/i18n/agent-panel.ts":
				"the agent panel's text names its `/<root> profile` command",
		};
		const panelCommand = /`?\/\$\{[^}]+\} profile`?|\/<root> profile/;
		const found = coreFiles(CORE).flatMap((file) => {
			const path = relative(ROOT, file);
			if (path === relative(ROOT, import.meta.path)) return [];
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((text, index) => {
					if (!concept.test(text)) return [];
					if (path in allowed && panelCommand.test(text)) return [];
					return [`${path}:${index + 1}: ${text.trim()}`];
				});
		});
		expect(found).toEqual([]);
	});
});
