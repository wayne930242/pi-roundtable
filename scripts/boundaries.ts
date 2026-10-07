import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { PUBLIC_ENTRIES } from "./public-api.ts";

/**
 * The import rules the code keeps until Discord moves into its own adapter:
 * - `discord-package`: only the Discord area's own files and its entry import discord.js,
 *   discord-api-types, or @discordjs; tests may, to build stand-ins.
 * - `discord-area`: code outside the Discord area does not reach into `src/core/discord` or the
 *   `pi-roundtable/discord` entry's source.
 * - `package-entry`: a workspace package imports pi-roundtable only through its public entries,
 *   and nothing outside its own directory by a relative path.
 */
export type BoundaryRule = "discord-package" | "discord-area" | "package-entry";

export interface Violation {
	rule: BoundaryRule;
	/** The importing file, relative to the root, with forward slashes. */
	file: string;
	specifier: string;
}

const SOURCE = /\.(ts|tsx|mts|mjs)$/;
const TEST = /\.test\.(ts|tsx)$/;
const DISCORD_PACKAGES = /^(discord\.js|discord-api-types|@discordjs\/)/;

/** The files that may import a Discord package. */
const DISCORD_PACKAGE_USERS = [
	/^src\/core\/discord\//,
	/^src\/discord\//,
	/^src\/cli\/discord-api\.ts$/,
];

/**
 * The Discord area: its own files, its entry, the plugins that compose it, the CLI, and the test
 * helpers with the testing entry, which hand out a stand-in Discord.
 */
const DISCORD_AREA = [
	/^src\/core\/discord\//,
	/^src\/discord\//,
	/^src\/core\/builtin\/discord(-admin)?\.ts$/,
	/^src\/core\/modules\/discord-admin\//,
	/^src\/cli\//,
	/^src\/core\/testing\//,
	/^src\/testing\.ts$/,
];

/** Where the Discord area's internals live; outside the area, nothing imports them. */
const DISCORD_INTERNALS = [/^src\/core\/discord\//, /^src\/discord\//];

/** The specifiers a workspace package may use to reach pi-roundtable. */
const ENTRY_SPECIFIERS = new Set(
	Object.keys(PUBLIC_ENTRIES).map((entry) =>
		entry === "main" ? "pi-roundtable" : `pi-roundtable/${entry}`,
	),
);

const posix = (path: string): string => path.split(sep).join("/");
const matches = (path: string, patterns: readonly RegExp[]): boolean =>
	patterns.some((pattern) => pattern.test(path));

/** Every module specifier the source names: imports, re-exports, `import()`, and `require()`. */
export function importsOf(source: string, file = "source.ts"): string[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: [
			"typescript",
			...(file.endsWith("x") ? (["jsx"] as const) : []),
			"importAttributes",
		],
	});
	const found: string[] = [];
	function visit(node: unknown): void {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		const value = node as {
			type?: string;
			source?: { type?: string; value?: unknown } | null;
			callee?: { type?: string; name?: string };
			arguments?: { type?: string; value?: unknown }[];
			moduleReference?: { expression?: { value?: unknown } };
		};
		if (
			(value.type === "ImportDeclaration" ||
				value.type === "ExportNamedDeclaration" ||
				value.type === "ExportAllDeclaration" ||
				value.type === "ImportExpression") &&
			typeof value.source?.value === "string"
		)
			found.push(value.source.value);
		if (
			value.type === "CallExpression" &&
			(value.callee?.type === "Import" ||
				(value.callee?.type === "Identifier" &&
					value.callee.name === "require")) &&
			typeof value.arguments?.[0]?.value === "string"
		)
			found.push(value.arguments[0].value);
		if (
			value.type === "TSImportEqualsDeclaration" &&
			typeof value.moduleReference?.expression?.value === "string"
		)
			found.push(value.moduleReference.expression.value);
		for (const [key, child] of Object.entries(node))
			if (key !== "loc" && key !== "start" && key !== "end") visit(child);
	}
	visit(ast.program);
	return found;
}

/** The source files under `dir`, skipping installed and built output. */
function sourcesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".")) return [];
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "node_modules" || entry.name === "dist"
				? []
				: sourcesUnder(path);
		return SOURCE.test(entry.name) ? [path] : [];
	});
}

/** A relative specifier resolved against the importing file, relative to the root. */
function resolved(root: string, file: string, specifier: string): string {
	return posix(relative(root, resolve(dirname(join(root, file)), specifier)));
}

function coreViolations(root: string): Violation[] {
	const violations: Violation[] = [];
	for (const path of sourcesUnder(join(root, "src"))) {
		const file = posix(relative(root, path));
		if (TEST.test(file)) continue;
		for (const specifier of importsOf(readFileSync(path, "utf8"), file)) {
			if (
				DISCORD_PACKAGES.test(specifier) &&
				!matches(file, DISCORD_PACKAGE_USERS)
			)
				violations.push({ rule: "discord-package", file, specifier });
			if (
				specifier.startsWith(".") &&
				!matches(file, DISCORD_AREA) &&
				matches(resolved(root, file, specifier), DISCORD_INTERNALS)
			)
				violations.push({ rule: "discord-area", file, specifier });
		}
	}
	return violations;
}

function packageViolations(root: string): Violation[] {
	const packages = join(root, "packages");
	if (!existsSync(packages)) return [];
	const violations: Violation[] = [];
	for (const name of readdirSync(packages)) {
		const home = `packages/${name}/`;
		for (const path of sourcesUnder(join(packages, name))) {
			const file = posix(relative(root, path));
			for (const specifier of importsOf(readFileSync(path, "utf8"), file)) {
				const deep =
					specifier.startsWith("pi-roundtable/") &&
					!ENTRY_SPECIFIERS.has(specifier);
				const outside =
					specifier.startsWith(".") &&
					!`${resolved(root, file, specifier)}/`.startsWith(home);
				if (deep || outside)
					violations.push({ rule: "package-entry", file, specifier });
			}
		}
	}
	return violations;
}

/** Every import that breaks a boundary rule, sorted by rule, file, and specifier. */
export function boundaryViolations(root: string): Violation[] {
	const key = (v: Violation) => `${v.rule}\u0000${v.file}\u0000${v.specifier}`;
	return [...coreViolations(root), ...packageViolations(root)].sort(
		(a, b) => Number(key(a) > key(b)) - Number(key(a) < key(b)),
	);
}

if (import.meta.main) {
	const root = resolve(process.argv[2] ?? ".");
	const violations = boundaryViolations(root);
	// pi-lens-ignore: no-console-except-error — the script's printed report is its product
	console.log(JSON.stringify(violations, null, "\t"));
}
