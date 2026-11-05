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
 *
 * And the layers of the core, whose directories name them:
 * - `core-kernel`: `src/core/kernel` imports nothing else of the core, so every layer builds on it.
 * - `core-host`: `src/core/host` assembles every other layer into a running host, so only the host
 *   and the test helpers import it.
 *
 * `coreCycles` adds that no two directories of the core depend on each other at run time.
 */
export type BoundaryRule =
	| "discord-package"
	| "discord-area"
	| "package-entry"
	| "core-kernel"
	| "core-host";

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

const CORE = "src/core/";
const KERNEL = "src/core/kernel/";
const HOST = "src/core/host/";
const TEST_HELPERS = "src/core/testing/";

/** The specifiers a workspace package may use to reach pi-roundtable. */
const ENTRY_SPECIFIERS = new Set(
	Object.keys(PUBLIC_ENTRIES).map((entry) =>
		entry === "main" ? "pi-roundtable" : `pi-roundtable/${entry}`,
	),
);

const posix = (path: string): string => path.split(sep).join("/");
const matches = (path: string, patterns: readonly RegExp[]): boolean =>
	patterns.some((pattern) => pattern.test(path));

/**
 * Every module specifier the source names: imports, re-exports, `import()`, and `require()`;
 * with `valuesOnly`, without the `import type` and `export type` ones, which run nothing.
 */
export function importsOf(
	source: string,
	file = "source.ts",
	valuesOnly = false,
): string[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript", ...(file.endsWith("x") ? (["jsx"] as const) : [])],
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
			importKind?: string;
			exportKind?: string;
		};
		const typeOnly = value.importKind === "type" || value.exportKind === "type";
		if (
			(value.type === "ImportDeclaration" ||
				value.type === "ExportNamedDeclaration" ||
				value.type === "ExportAllDeclaration" ||
				value.type === "ImportExpression") &&
			typeof value.source?.value === "string" &&
			!(valuesOnly && typeOnly)
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
			if (!specifier.startsWith(".")) continue;
			const target = resolved(root, file, specifier);
			if (!matches(file, DISCORD_AREA) && matches(target, DISCORD_INTERNALS))
				violations.push({ rule: "discord-area", file, specifier });
			if (
				file.startsWith(KERNEL) &&
				target.startsWith(CORE) &&
				!target.startsWith(KERNEL)
			)
				violations.push({ rule: "core-kernel", file, specifier });
			if (
				target.startsWith(HOST) &&
				file.startsWith(CORE) &&
				!file.startsWith(HOST) &&
				!file.startsWith(TEST_HELPERS)
			)
				violations.push({ rule: "core-host", file, specifier });
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

/** The directory of the core that holds `file`: its first directory, or `modules/<name>` for a module. */
function coreArea(file: string): string | undefined {
	if (!file.startsWith(CORE)) return undefined;
	const parts = file.slice(CORE.length).split("/");
	if (parts.length < 2) return undefined;
	return parts[0] === "modules" && parts.length > 2
		? `modules/${parts[1]}`
		: parts[0];
}

/** The groups of nodes that reach each other through `edges` (Tarjan's strongly connected components). */
function stronglyConnected(
	edges: ReadonlyMap<string, Set<string>>,
): string[][] {
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const groups: string[][] = [];
	const visit = (node: string): void => {
		index.set(node, index.size);
		low.set(node, index.get(node) ?? 0);
		stack.push(node);
		for (const next of edges.get(node) ?? []) {
			if (!index.has(next)) visit(next);
			if (stack.includes(next))
				low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
		}
		if (low.get(node) !== index.get(node)) return;
		const group: string[] = [];
		let member: string | undefined;
		do {
			member = stack.pop();
			if (member !== undefined) group.push(member);
		} while (member !== undefined && member !== node);
		groups.push(group);
	};
	for (const node of edges.keys()) if (!index.has(node)) visit(node);
	return groups;
}

/**
 * The directories of the core that depend on each other at run time, each cycle as its directories
 * in order. A type-only import runs nothing and does not count; neither do tests and the test
 * helpers, which may reach any layer.
 */
export function coreCycles(root: string): string[][] {
	const edges = new Map<string, Set<string>>();
	for (const path of sourcesUnder(join(root, CORE))) {
		const file = posix(relative(root, path));
		const from = coreArea(file);
		if (!from || TEST.test(file) || file.startsWith(TEST_HELPERS)) continue;
		const targets = edges.get(from) ?? new Set<string>();
		edges.set(from, targets);
		for (const specifier of importsOf(readFileSync(path, "utf8"), file, true)) {
			if (!specifier.startsWith(".")) continue;
			const to = coreArea(resolved(root, file, specifier));
			if (to && to !== from) targets.add(to);
		}
	}
	return stronglyConnected(edges)
		.filter((group) => group.length > 1)
		.map((group) => group.sort((a, b) => a.localeCompare(b)))
		.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

if (import.meta.main) {
	const root = resolve(process.argv[2] ?? ".");
	const violations = boundaryViolations(root);
	// pi-lens-ignore: no-console-except-error — the script's printed report is its product
	console.log(JSON.stringify(violations, null, "\t"));
}
