import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	boundaryViolations,
	coreCycles,
	discordNames,
	importsOf,
	surfaceToolNames,
	type Violation,
} from "./boundaries.ts";

const ROOT = resolve(import.meta.dir, "..");

const trees: string[] = [];
afterEach(() => {
	for (const dir of trees.splice(0)) rmSync(dir, { recursive: true });
});

/** A checkout of the given files, by path. */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "roundtable-boundaries-"));
	trees.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

test("the checkout breaks no boundary beyond the recorded baseline, which only shrinks", () => {
	const baseline = JSON.parse(
		readFileSync(join(ROOT, "scripts/boundaries.baseline.json"), "utf8"),
	) as Violation[];
	// Exact: a new violation fails, and a fixed one prompts removing it from the baseline.
	expect(boundaryViolations(ROOT)).toEqual(baseline);
	// What remains is the thread host and the schedule commands, which move with the Discord adapter.
	expect(baseline.map((v) => v.rule)).toEqual(
		baseline.map(() => "discord-area"),
	);
	expect(baseline.length).toBeLessThanOrEqual(5);
});

test("no two directories of the core depend on each other at run time", () => {
	expect(coreCycles(ROOT)).toEqual([]);
});

test("only the Discord area imports a Discord package; tests may", () => {
	const root = tree({
		"src/core/discord/surface.ts": 'import { Client } from "discord.js";',
		"src/discord/index.ts":
			'export type { APIUser } from "discord-api-types/v10";',
		"src/cli/discord-api.ts": 'import { Routes } from "discord-api-types/v10";',
		"src/core/routing/router.ts": 'import type { Message } from "discord.js";',
		"src/core/runtime/x.ts": 'const rest = await import("@discordjs/rest");',
		"src/core/routing/router.test.ts": 'import { Client } from "discord.js";',
	});
	expect(boundaryViolations(root)).toEqual([
		{
			rule: "discord-package",
			file: "src/core/routing/router.ts",
			specifier: "discord.js",
		},
		{
			rule: "discord-package",
			file: "src/core/runtime/x.ts",
			specifier: "@discordjs/rest",
		},
	]);
});

test("code outside the Discord area does not reach into its internals", () => {
	const root = tree({
		"src/core/discord/connection.ts": "export const a = 1;",
		"src/core/builtin/discord.ts":
			'import { a } from "../discord/connection.ts";',
		"src/core/testing/fake.ts": 'import { a } from "../discord/connection.ts";',
		"src/testing.ts": 'export { a } from "./core/discord/connection.ts";',
		"src/core/routing/router.ts":
			'import type { a } from "../discord/connection.ts";',
		"src/index.ts": 'export { DISCORD } from "./discord/index.ts";',
		"src/core/routing/names.ts": 'import { b } from "./discord-names.ts";',
	});
	expect(boundaryViolations(root)).toEqual([
		{
			rule: "discord-area",
			file: "src/core/routing/router.ts",
			specifier: "../discord/connection.ts",
		},
		{
			rule: "discord-area",
			file: "src/index.ts",
			specifier: "./discord/index.ts",
		},
	]);
});

test("a workspace package imports pi-roundtable only through its public entries, and nothing outside itself", () => {
	const root = tree({
		"packages/chat/src/plugin.ts": [
			'import { definePlugin } from "pi-roundtable";',
			'import { testPlugin } from "pi-roundtable/testing";',
			'import { serveUnix } from "pi-roundtable/kit";',
			'import { DISCORD } from "pi-roundtable/discord";',
			'import pkg from "../package.json" with { type: "json" };',
			'import { RUNTIME } from "pi-roundtable/src/core/services.ts";',
			'import { host } from "../../../src/core/host.ts";',
		].join("\n"),
		"packages/chat/web/app.tsx":
			'import { api } from "../src/api.ts";\nexport const App = () => <div />;',
		"packages/chat/node_modules/x/index.ts": 'import "pi-roundtable/src/x.ts";',
	});
	expect(boundaryViolations(root)).toEqual([
		{
			rule: "package-entry",
			file: "packages/chat/src/plugin.ts",
			specifier: "../../../src/core/host.ts",
		},
		{
			rule: "package-entry",
			file: "packages/chat/src/plugin.ts",
			specifier: "pi-roundtable/src/core/services.ts",
		},
	]);
});

test("every way of naming a module is read", () => {
	expect(
		importsOf(
			[
				'import a from "a";',
				'import type { B } from "b";',
				'export { c } from "c";',
				'export * from "d";',
				'const e = await import("e");',
				'const f = require("f");',
				'import g = require("g");',
			].join("\n"),
		),
	).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
});

test("the kernel imports nothing else of the core, and only the host and the test helpers import the host", () => {
	const root = tree({
		"src/core/kernel/time.ts": 'import { log } from "./log.ts";',
		"src/core/kernel/log.ts":
			'import type { Speaker } from "../identity/speakers.ts";',
		"src/core/kernel/freeze.ts":
			'import { CATALOG } from "../../characters/index.ts";',
		"src/core/agents/agent.ts": 'import { Roundtable } from "../host/host.ts";',
		"src/core/agents/agent.test.ts":
			'import { Roundtable } from "../host/host.ts";',
		"src/core/host/drain.ts": 'import { Roundtable } from "./host.ts";',
		"src/core/testing/test-host.ts":
			'import { Roundtable } from "../host/host.ts";',
		"src/cli/run.ts": 'import { Roundtable } from "../core/host/host.ts";',
	});
	expect(boundaryViolations(root)).toEqual([
		{
			rule: "core-host",
			file: "src/core/agents/agent.ts",
			specifier: "../host/host.ts",
		},
		{
			rule: "core-kernel",
			file: "src/core/kernel/log.ts",
			specifier: "../identity/speakers.ts",
		},
	]);
});

test("a cycle between core directories counts imports that run, and skips tests and the test helpers", () => {
	const root = tree({
		"src/core/agents/agent.ts": 'import { route } from "../routing/route.ts";',
		"src/core/routing/route.ts": 'export { agent } from "../agents/agent.ts";',
		"src/core/config/config.ts":
			'import type { Who } from "../identity/who.ts";',
		"src/core/identity/who.ts": 'import { config } from "../config/config.ts";',
		"src/core/modules/memory/memory.ts":
			'const skills = await import("../skills/skills.ts");',
		"src/core/modules/skills/skills.ts": 'import "../memory/memory.ts";',
		"src/core/testing/fake.ts": 'import { agent } from "../agents/agent.ts";',
		"src/core/agents/fake.test.ts":
			'import { fake } from "../testing/fake.ts";',
		"src/core/kernel/log.ts": "export const log = 1;",
	});
	expect(coreCycles(root)).toEqual([
		["agents", "routing"],
		["modules/memory", "modules/skills"],
	]);
});

test("the imports that run leave out the type-only ones", () => {
	expect(
		importsOf(
			[
				'import a from "a";',
				'import type { B } from "b";',
				'export type { C } from "c";',
				'import { type D, d } from "d";',
				'export * from "e";',
				'const f = await import("f");',
			].join("\n"),
			"source.ts",
			true,
		),
	).toEqual(["a", "d", "e", "f"]);
});

test("the team code names Discord no more than the recorded allowlist, which only shrinks", () => {
	const baseline = JSON.parse(
		readFileSync(join(ROOT, "scripts/discord-names.baseline.json"), "utf8"),
	);
	// Exact: a new mention, or a recorded file that gained one, fails; a recorded one that shrank
	// prompts lowering its count, or removing the file once it is clean. Move the name behind a
	// surface contract rather than raise a count. `bun scripts/boundaries.ts --discord-names` prints the list.
	expect(discordNames(ROOT)).toEqual(baseline);
});

test("agents, routing, and threads name no Discord surface, key, or guild; comments, messages, tests, and other directories may", () => {
	const root = tree({
		"src/core/agents/clean.ts": [
			"// Discord and the guild are the adapter's: this comment names them freely.",
			"export const note = 'A Discord channel';",
			"export const room = (surface: string) => `$" + "{surface}:agent`;",
		].join("\n"),
		"src/core/agents/leaky.ts": [
			'import { discordKey } from "./team-keys.ts";',
			"export const key = discordKey('1');",
			'export const same = (surface: string) => surface === "discord";',
			'export const origin = (key: string) => key.startsWith("discord:");',
			"export const scope = (guildId: string) => `guild_id = $" + "{guildId}`;",
		].join("\n"),
		"src/core/routing/leaky.ts":
			'export const mention = (surface: string) => surface === "discord";',
		"src/core/agents/leaky.test.ts": 'export const key = discordKey("1");',
		"src/core/discord/surface.ts": 'export const key = discordKey("1");',
		"src/core/threads/leaky.ts": "export const guild = { guildId: 1 }.guildId;",
	});
	expect(discordNames(root)).toEqual({
		"src/core/agents/leaky.ts": {
			"discord-identifier": 2,
			"discord-surface": 2,
			guild: 3,
		},
		"src/core/routing/leaky.ts": { "discord-surface": 1 },
		"src/core/threads/leaky.ts": { guild: 3 },
	});
});

test("the team code names no surface's own tool or creation argument", () => {
	// Exact: Discord's `channel_arrange`, `channel_read` and `category` are contributed by its builtin.
	expect(surfaceToolNames(ROOT)).toEqual({});
});

test("a tool name or a creation argument in team code is found; comments, tests, other directories and longer words are not", () => {
	const root = tree({
		"src/core/agents/clean.ts": [
			"// channel_arrange and category are Discord's: this comment names them freely.",
			"export const note = 'Move it to a category with the arrange tool';",
			"export const layout = { categoryLayout: 1 };",
		].join("\n"),
		"src/core/agents/leaky.ts": [
			"export const tools = ['channel_arrange', `x channel_read y`];",
			"export const input = { category: 'Agents' };",
			"export const schema = { categories: [] };",
		].join("\n"),
		"src/core/agents/leaky.test.ts": "export const category = 'Agents';",
		"src/core/discord/tools.ts": "export const category = 'Agents';",
	});
	expect(surfaceToolNames(root)).toEqual({
		"src/core/agents/leaky.ts": [
			"categories",
			"category",
			"channel_arrange",
			"channel_read",
		],
	});
});
