import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANES } from "./api-types.ts";

const packageDir = join(import.meta.dir, "..");
const repository = join(packageDir, "..", "..");

const options = readFileSync(join(import.meta.dir, "options.ts"), "utf8");

/** The source between a declaration line and the first line that closes it at column 0. */
function block(start: string): string[] {
	const lines = options.split("\n");
	const from = lines.findIndex((line) => line.startsWith(start));
	if (from < 0) throw new Error(`options.ts has no "${start}"`);
	const body: string[] = [];
	for (const line of lines.slice(from + 1)) {
		if (/^[}\]]|^\S/.test(line)) break;
		body.push(line);
	}
	return body;
}

/**
 * The option paths a type declares: `origin`, `push.subject`, `appearance.look`. An object type
 * nests by indentation, and an inline one (`{ dir: string }`) is read member by member.
 */
function paths(body: string[], prefix = ""): string[] {
	const found: string[] = [];
	const open: { depth: number; name: string }[] = [];
	for (const line of body) {
		const tabs = /^\t*/.exec(line)?.[0].length ?? 0;
		while (open.length > 0 && tabs <= (open.at(-1)?.depth ?? 0)) open.pop();
		const member = /^\t+([A-Za-z]+)\??:(.*)$/.exec(line);
		if (!member || tabs > (open.at(-1)?.depth ?? 0) + 1) continue;
		const path = [prefix, ...open.map((entry) => entry.name), member[1]]
			.filter(Boolean)
			.join(".");
		found.push(path);
		const rest = (member[2] ?? "").trim();
		if (rest.endsWith("{")) open.push({ depth: tabs, name: member[1] ?? "" });
		else if (rest.startsWith("{"))
			for (const inner of rest.matchAll(/([A-Za-z]+)\??:/g))
				found.push(`${path}.${inner[1]}`);
	}
	return found;
}

/** What `WebConsoleOptions` takes, `auth`'s members included. */
export function optionPaths(): string[] {
	const top = paths(block("export interface WebConsoleOptions"));
	const auth = new Set<string>();
	for (const line of block("export type WebAuthOptions"))
		for (const member of line.matchAll(/^\t{3}([A-Za-z]+)\??:/g))
			auth.add(`auth.${member[1]}`);
	return [...new Set([...top, ...auth])];
}

const documents = [
	"packages/web/README.md",
	"site/src/content/docs/plugins/web-package.mdx",
	"site/src/content/docs/zh-tw/plugins/web-package.mdx",
];

describe("the options the docs describe", () => {
	test("the extractor finds the options it should", () => {
		const found = optionPaths();
		for (const path of [
			"auth",
			"auth.mode",
			"auth.trustNetwork",
			"auth.passwordEnv",
			"auth.sessionDays",
			"auth.principal",
			"verifier",
			"origin",
			"panes",
			"surface",
			"cardGraceSeconds",
			"uploadMaxBytes",
			"push",
			"push.preview",
			"push.endpointHosts",
			"push.subject",
			"icons",
			"icons.dir",
			"appearance",
			"appearance.look",
		])
			expect(found).toContain(path);
		expect(found.length).toBeGreaterThan(30);
	});

	for (const document of documents) {
		const text = readFileSync(join(repository, document), "utf8");

		test(`${document} names every WebConsoleOptions key`, () => {
			const missing = optionPaths().filter(
				(path) => !text.includes(`\`${path}\``),
			);
			expect(missing).toEqual([]);
		});

		test(`${document} names every pane`, () => {
			const missing = PANES.filter((pane) => !text.includes(`\`${pane}\``));
			expect(missing).toEqual([]);
		});
	}

	test("the README lists a screenshot slot for every look, scheme and device", () => {
		const text = readFileSync(join(packageDir, "README.md"), "utf8");
		const missing: string[] = [];
		for (const look of ["modern", "camelot"])
			for (const scheme of ["light", "dark"])
				for (const device of ["phone", "desktop"]) {
					const name = `docs/images/web/${look}-${scheme}-${device}.png`;
					if (!text.includes(`\`${name}\``)) missing.push(name);
				}
		expect(missing).toEqual([]);
	});
});
