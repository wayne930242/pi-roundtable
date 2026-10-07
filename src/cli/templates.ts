import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

/** The templates the package ships, as real files beside the source. */
export const TEMPLATES_DIR = join(import.meta.dir, "../../templates");

/** The directory of the plugin template, rendered once for `hello` and again for every `add plugin`. */
const PLUGIN_DIR = "plugin";

/** The directory of the official plugins, one directory each, named as `add plugin` names them. */
const OFFICIAL_DIR = "official";

/** The directory of the plugin `add package` writes around a Pi package. */
const PACKAGE_DIR = "package";

/** The directory of each chat network's files that replace or add to the skeleton's, one directory per adapter. */
const ADAPTERS_DIR = "adapters";

/** The chat networks `init` can set a project up for; Discord's files are the skeleton itself. */
export const ADAPTERS = ["discord", "web"] as const;
export type Adapter = (typeof ADAPTERS)[number];

/** Whether `name` is an adapter `init` knows. */
export const isAdapter = (name: string): name is Adapter =>
	(ADAPTERS as readonly string[]).includes(name);

/** Skeleton files a project for the adapter leaves out: a web project has no agents and no shared persona. */
const LEFT_OUT: Readonly<Record<Adapter, readonly string[]>> = {
	discord: [],
	web: ["agents.ts", "persona/shared.md"],
};

/** The plugins the package ships ready-made: `add plugin <name>` copies these instead of the `hello` template, so the names are reserved. */
export const OFFICIAL_PLUGINS = [
	"codex-images",
	"dice",
	"release-notice",
] as const;

/** Whether `name` is one of the official plugins. */
export const isOfficialPlugin = (name: string): boolean =>
	(OFFICIAL_PLUGINS as readonly string[]).includes(name);

/** What a template file may say, replaced when it is rendered. */
export interface Substitutions {
	/** The project's package name. */
	project: string;
	/** The exact version of pi-roundtable the project depends on. */
	version: string;
}

/** The words a plugin template is written in: the kebab name, its identifier, and its tool prefix. */
export interface PluginNames {
	name: string;
	ident: string;
	tool: string;
}

/** A file to write: where, and what. */
export interface Rendered {
	path: string;
	content: string;
}

/** Files that tools would act on in place are stored with a `.tmpl` suffix; npm also drops `.gitignore`. */
function targetOf(path: string): string {
	const name = path.replace(/\.tmpl$/, "");
	return name.endsWith("_gitignore")
		? name.replace("_gitignore", ".gitignore")
		: name;
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

/** `my-notes` as the words a template needs. */
export function pluginNames(name: string): PluginNames {
	return {
		name,
		ident: name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()),
		tool: name.replaceAll("-", "_"),
	};
}

/** A plugin name is lowercase words joined by dashes, as `definePlugin` requires. */
export const isPluginName = (name: string): boolean =>
	/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name);

function fill(text: string, values: Record<string, string>): string {
	return text.replace(/__([A-Z]+)__/g, (whole, key: string) => {
		const value = values[key];
		if (value === undefined)
			throw new Error(`template placeholder ${whole} has no value`);
		return value;
	});
}

/** The plugin and its test, written for `names`: the official plugin of that name, or else the `hello` template. */
export function renderPlugin(
	names: PluginNames,
	dir = TEMPLATES_DIR,
): Rendered[] {
	const values = { NAME: names.name, IDENT: names.ident, TOOL: names.tool };
	const source = isOfficialPlugin(names.name)
		? join(OFFICIAL_DIR, names.name)
		: PLUGIN_DIR;
	return [
		["plugin.ts", `plugins/${names.name}.ts`],
		["plugin.test.ts.tmpl", `plugins/${names.name}.test.ts`],
	].map(([file, path]) => ({
		path: path as string,
		content: fill(
			readFileSync(join(dir, source, file as string), "utf8"),
			values,
		),
	}));
}

/** The `TOOLS` constant as the project's formatter writes it: on one line when it fits in 80 columns. */
function toolsConstant(tools: readonly string[]): string {
	const items = tools.map((tool) => JSON.stringify(tool));
	const line = `const TOOLS: string[] = [${items.join(", ")}];`;
	return line.length <= 80
		? line
		: `const TOOLS: string[] = [\n${items.map((item) => `\t${item},\n`).join("")}];`;
}

/** The plugin `add package` writes around the Pi package `pkg`, and its test, with the tools the package registers. */
export function renderPackagePlugin(
	names: PluginNames,
	pkg: string,
	tools: readonly string[],
	dir = TEMPLATES_DIR,
): Rendered[] {
	const values = {
		NAME: names.name,
		IDENT: names.ident,
		PACKAGE: pkg,
		TOOLS: toolsConstant(tools),
	};
	return [
		["plugin.ts.tmpl", `plugins/${names.name}.ts`],
		["plugin.test.ts.tmpl", `plugins/${names.name}.test.ts`],
	].map(([file, path]) => ({
		path: path as string,
		content: fill(
			readFileSync(join(dir, PACKAGE_DIR, file as string), "utf8"),
			values,
		),
	}));
}

/**
 * Every file of a new project for `adapter` (default Discord): the skeleton, without the files the
 * adapter leaves out and with its own files in place of the skeleton's, and the `hello` plugin;
 * paths relative to the project.
 */
export function renderProject(
	substitutions: Substitutions,
	dir = TEMPLATES_DIR,
	adapter: Adapter = "discord",
): Rendered[] {
	if (!existsSync(dir)) throw new Error(`templates are missing: ${dir}`);
	const values = {
		PROJECT: substitutions.project,
		VERSION: substitutions.version,
	};
	const render = (base: string, path: string): Rendered => ({
		path: targetOf(path),
		content: fill(readFileSync(join(base, path), "utf8"), values),
	});
	const overlayDir = join(dir, ADAPTERS_DIR, adapter);
	const overlay = existsSync(overlayDir)
		? filesUnder(overlayDir).map((file) =>
				render(overlayDir, relative(overlayDir, file)),
			)
		: [];
	const replaced = new Set([
		...LEFT_OUT[adapter],
		...overlay.map((file) => file.path),
	]);
	const skeleton = filesUnder(dir)
		.map((file) => relative(dir, file))
		.filter(
			(path) =>
				![PLUGIN_DIR, OFFICIAL_DIR, PACKAGE_DIR, ADAPTERS_DIR].some((sub) =>
					path.startsWith(`${sub}/`),
				),
		)
		.map((path) => render(dir, path))
		.filter((file) => !replaced.has(file.path));
	return [...skeleton, ...overlay, ...renderPlugin(pluginNames("hello"), dir)];
}

/** Writes rendered files under `root`, creating directories; the caller has checked that none exists. */
export function writeRendered(root: string, files: readonly Rendered[]): void {
	for (const file of files) {
		const target = join(root, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.content);
	}
}
