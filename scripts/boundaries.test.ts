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
import { boundaryViolations, importsOf, type Violation } from "./boundaries.ts";

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
