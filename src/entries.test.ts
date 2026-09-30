import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as main from "./index.ts";
import * as testing from "./testing.ts";

// Types disappear at runtime. Update this list AND the changelog for every entry change.
export const MAIN_EXPORTS = [
	"NotLinkedError",
	"PluginError",
	"Roundtable",
	"ToolRefusal",
	"definePlugin",
	"defineRoundtable",
	"defineTool",
];
export const MAIN_TYPE_EXPORTS = [
	"AgentSeed",
	"ChannelClaim",
	"Contribution",
	"DefinedRoundtable",
	"EventHandlers",
	"HoldRule",
	"InteractionContribution",
	"Migration",
	"PluginContext",
	"PromptSection",
	"PromptTurn",
	"RoundtableConfig",
	"RoundtableOptions",
	"RoundtablePlugin",
	"Service",
	"SessionTool",
	"Speaker",
	"Tier",
	"ToolContribution",
	"ToolSpec",
	"ToolTurn",
	"TurnEndEvent",
	"TurnEvent",
];
export const TESTING_EXPORTS = ["testPlugin"];
export const TESTING_TYPE_EXPORTS = [
	"RecordedEvent",
	"TestPluginOptions",
	"TestPluginResult",
];

/** Source-level names include type-only exports, which Object.keys cannot observe. */
function entryNames(path: string): string[] {
	const source = readFileSync(path, "utf8");
	if (path.endsWith("index.ts"))
		return [...source.matchAll(/export(?: type)?\s*\{([^}]+)\}/gs)]
			.flatMap((match) =>
				(match[1] ?? "")
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
			)
			.sort();
	return [
		...source.matchAll(
			/export (?:async )?(?:interface|function|type|class|const) (\w+)/g,
		),
	]
		.map((match) => match[1] ?? "")
		.sort();
}

test("the public entries have exactly the snapshotted runtime exports", () => {
	expect(Object.keys(main).sort()).toEqual(MAIN_EXPORTS);
	expect(Object.keys(testing).sort()).toEqual(TESTING_EXPORTS);
});

test("type-only names are snapshotted and every public name is in the changelog", () => {
	expect(entryNames(resolve(import.meta.dir, "index.ts"))).toEqual(
		[...MAIN_EXPORTS, ...MAIN_TYPE_EXPORTS].sort(),
	);
	expect(entryNames(resolve(import.meta.dir, "testing.ts"))).toEqual(
		[...TESTING_EXPORTS, ...TESTING_TYPE_EXPORTS].sort(),
	);
	const local = resolve(import.meta.dir, "../packaging/CHANGELOG.md");
	const changelog = readFileSync(
		existsSync(local) ? local : resolve(import.meta.dir, "../CHANGELOG.md"),
		"utf8",
	);
	for (const name of [
		...MAIN_EXPORTS,
		...MAIN_TYPE_EXPORTS,
		...TESTING_EXPORTS,
		...TESTING_TYPE_EXPORTS,
	])
		expect(changelog).toContain(`\`${name}\``);
});

test("the package export map names exactly the existing entries", () => {
	const template = resolve(import.meta.dir, "../packaging/package.json.tmpl");
	const packageFile = existsSync(template)
		? template
		: resolve(import.meta.dir, "../package.json");
	const manifest = JSON.parse(readFileSync(packageFile, "utf8")) as {
		exports: Record<string, string>;
	};
	expect(manifest.exports).toEqual({
		".": "./src/index.ts",
		"./testing": "./src/testing.ts",
	});
	for (const target of Object.values(manifest.exports))
		expect(
			Bun.file(resolve(import.meta.dir, "..", target)).size,
		).toBeGreaterThan(0);
});
