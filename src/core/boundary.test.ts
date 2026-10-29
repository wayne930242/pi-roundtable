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
				// The characters kit is a browser-safe library the core builds on; a test keeps it free of core imports.
				.filter(
					(path) =>
						!path.startsWith("src/core/") &&
						!path.startsWith("src/characters/"),
				)
				.map((path) => `${relative(ROOT, file)} -> ${path}`),
		);
		expect(outside).toEqual([]);
	});

	test("the core never imports a consumer's plugins", () => {
		const consumers = readdirSync(join(ROOT, "src"), { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					entry.name !== "core" &&
					entry.name !== "characters",
			)
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
		// Since 0.26 the core names people through `PROFILES`: a person's name and picture, one per
		// linked account. That is a generic concept, not a consumer's profile catalogue, so these
		// files may say "profile"; they still may not name the other concepts.
		const personProfiles = new Set([
			"src/core/config/config-schema.ts",
			"src/core/config/config.ts",
			"src/core/config/profiles.test.ts",
			"src/core/config/profiles.ts",
			"src/core/define-roundtable.test.ts",
			"src/core/define-roundtable.ts",
			"src/core/host-services.test.ts",
			"src/core/identity/identity-links.test.ts",
			"src/core/identity/identity-plugin.ts",
			"src/core/identity/identity-profiles.test.ts",
			"src/core/identity/identity-schema.ts",
			"src/core/identity/identity-service.ts",
			"src/core/identity/person-profiles.test.ts",
			"src/core/identity/person-profiles.ts",
			"src/core/identity/principal-tables.ts",
			"src/core/identity/profile-choices.ts",
			"src/core/identity/profiles-view.ts",
			"src/core/identity/profiles.ts",
			"src/core/services.ts",
		]);
		const otherConcept = /(?<![a-z])(party|connector|sol-?worker)/i;
		const panelCommand = /`?\/\$\{[^}]+\} profile`?|\/<root> profile/;
		const found = coreFiles(CORE).flatMap((file) => {
			const path = relative(ROOT, file);
			if (path === relative(ROOT, import.meta.path)) return [];
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((text, index) => {
					if (!concept.test(text)) return [];
					if (personProfiles.has(path) && !otherConcept.test(text)) return [];
					if (path in allowed && panelCommand.test(text)) return [];
					return [`${path}:${index + 1}: ${text.trim()}`];
				});
		});
		expect(found).toEqual([]);
	});
});
