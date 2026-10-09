import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type ApiReport,
	entryNames,
	publicApi,
} from "../scripts/public-api.ts";
import * as discord from "./discord/index.ts";
import * as main from "./index.ts";
import * as kit from "./kit/index.ts";
import * as testing from "./testing.ts";

const ROOT = resolve(import.meta.dir, "..");
const ENTRIES = {
	main: "src/index.ts",
	testing: "src/testing.ts",
	kit: "src/kit/index.ts",
	discord: "src/discord/index.ts",
};
const snapshot = JSON.parse(
	readFileSync(resolve(ROOT, "scripts/entries.exports.json"), "utf8"),
) as Record<string, { values: string[]; types: string[] }>;

function names(path: string) {
	return entryNames(readFileSync(resolve(ROOT, path), "utf8"));
}

test("entries have exactly the snapshotted runtime and type-only names, without duplicates", () => {
	const all: string[] = [];
	for (const [entry, module] of Object.entries({
		main,
		testing,
		kit,
		discord,
	})) {
		const expected = snapshot[entry];
		if (!expected) throw new Error(`Missing snapshot: ${entry}`);
		expect(Object.keys(module).sort()).toEqual(expected.values);
		expect(names(ENTRIES[entry as keyof typeof ENTRIES])).toEqual(expected);
		all.push(...expected.values, ...expected.types);
	}
	expect(all.length).toBe(new Set(all).size);
});

test("the export parser ignores comments and detects declared constants and signature-bearing exports", () => {
	expect(
		entryNames(
			"// export { fake };\n/* export type { Hidden }; */\nexport declare const actual: string;",
		),
	).toEqual({ values: ["actual"], types: [] });
	expect(
		entryNames("export { original as renamed }; export type { Thing };"),
	).toEqual({ values: ["renamed"], types: ["Thing"] });
	expect(() => entryNames('export * from "./other.ts"')).toThrow();
});

test("kit area files expose exactly its single entry's names", () => {
	const dir = resolve(ROOT, "src/kit");
	const all = readdirSync(dir)
		.filter((file) => file.endsWith(".ts") && file !== "index.ts")
		.flatMap((file) => {
			const found = names(`src/kit/${file}`);
			return [...found.values, ...found.types];
		})
		.sort();
	const expected = snapshot.kit;
	if (!expected) throw new Error("Missing kit snapshot");
	expect(all).toEqual([...expected.values, ...expected.types].sort());
});

test("every published name is recorded in the changelog and guide's entry index", () => {
	const local = resolve(ROOT, "packaging/CHANGELOG.md");
	const changelog = readFileSync(
		existsSync(local) ? local : resolve(ROOT, "CHANGELOG.md"),
		"utf8",
	);
	const guide = readFileSync(resolve(ROOT, "docs/plugins.md"), "utf8");
	for (const entry of ["main", "testing", "kit", "discord"]) {
		const found = snapshot[entry];
		if (!found) throw new Error(`Missing ${entry}`);
		for (const name of [...found.values, ...found.types]) {
			expect(changelog).toContain(`\`${name}\``);
			expect(guide).toContain(`| \`${name}\` |`);
		}
	}
});

test("the npm export map names only the four published entries", () => {
	const template = resolve(ROOT, "packaging/package.json.tmpl");
	const manifest = JSON.parse(
		readFileSync(
			existsSync(template) ? template : resolve(ROOT, "package.json"),
			"utf8",
		),
	) as { exports: Record<string, string>; files: string[] };
	expect(manifest.exports).toEqual({
		".": "./src/index.ts",
		"./testing": "./src/testing.ts",
		"./kit": "./src/kit/index.ts",
		"./discord": "./src/discord/index.ts",
	});
	for (const target of Object.values(manifest.exports))
		expect(Bun.file(resolve(ROOT, target)).size).toBeGreaterThan(0);
});

test("published declarations match the signature report and the remaining leak baseline", () => {
	const actual = publicApi(ROOT);
	const expected = JSON.parse(
		readFileSync(resolve(ROOT, "scripts/public-api.report.json"), "utf8"),
	) as ApiReport;
	// Includes each referenced declaration: changing a required property or function parameter fails.
	expect(actual.entries).toEqual(expected.entries);
	expect(actual.declarations).toEqual(expected.declarations);
	// Exact comparison rejects growth and prompts an intentional baseline update after shrinkage.
	expect(actual.leaks).toEqual(expected.leaks);
	expect(actual.discordTypes).toEqual(expected.discordTypes);
	for (const text of Object.values(actual.declarations))
		expect(text).not.toContain("/internal/");
}, 15_000);

test("published MemoryView exposes no guard-only legacyOwner attribution", () => {
	const report = publicApi(ROOT);
	expect(
		report.declarations[
			"src/core/runtime/extensions/private-memory.d.ts#MemoryView"
		],
	).not.toContain("legacyOwner");
}, 15_000);

test("the main and kit declarations name no discord.js type; only the discord entry does", () => {
	const { discordTypes } = publicApi(ROOT);
	// Every type the two entries reach, through any declaration, is free of discord.js.
	expect(discordTypes.main).toEqual([]);
	expect(discordTypes.kit).toEqual([]);
	// The scan sees the types it should: the Discord entry names them.
	const named = discordTypes.discord ?? [];
	expect(named.length).toBeGreaterThan(0);
	expect(named.some((use) => use.includes("discord.js:"))).toBe(true);
}, 15_000);

test("shared protocol constants cannot mutate the host through kit or discord", () => {
	for (const module of [kit, discord])
		for (const value of Object.values(module)) {
			if (value && typeof value === "object")
				expect(Object.isFrozen(value)).toBe(true);
		}
	expect(Object.isFrozen(discord.OPERATION_PERMISSIONS.read)).toBe(true);
	expect(Object.isFrozen(main.THE_SPEAKER.pronouns)).toBe(true);
	expect(Object.isFrozen(kit.DELEGATE_TOOL_SPEC.parameters)).toBe(true);
	expect(Object.isFrozen(discord.CHANNEL_TOOLS.discord_send_message)).toBe(
		true,
	);
	for (const module of [main, kit, discord, testing]) {
		expect("setLocale" in module).toBe(false);
		expect("setTimeZone" in module).toBe(false);
	}
	for (const name of [
		"AgentStore",
		"SkillStore",
		"OwnerMemoryStore",
		"ChannelQueue",
		"AgentTeam",
		"BackgroundTurns",
		"SkillRegistry",
		"ConfirmationJudge",
		"PiAgentRuntime",
	])
		expect(name in kit).toBe(false);
});

test("protocol constant types reject writes as well as runtime mutations", () => {
	// This callback is typechecked but never run against the shared host state.
	const writes = () => {
		// @ts-expect-error shared tool names are readonly
		discord.DISCORD_ADMIN_TOOLS.push("injected");
		// @ts-expect-error permission arrays are readonly
		discord.OPERATION_PERMISSIONS.read.push(0n);
		// @ts-expect-error tool records have readonly index signatures
		delete discord.CHANNEL_TOOLS.discord_get_channel_info;
		// @ts-expect-error nested speaker identity is readonly
		main.THE_SPEAKER.pronouns.subject = "changed";
		// @ts-expect-error delegation protocol is readonly
		kit.DELEGATE_TOOL_SPEC.name = "changed";
		// @ts-expect-error shell policy is readonly
		kit.shellHoldRule.name = "changed";
		// @ts-expect-error thinking levels are readonly
		kit.THINKING_LEVELS.push("high");
	};
	expect(typeof writes).toBe("function");
});
