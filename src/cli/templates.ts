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

/** The plugins the package ships ready-made: `add plugin <name>` copies these instead of the `hello` template, so the names are reserved. */
export const OFFICIAL_PLUGINS = ["codex-images", "dice"] as const;

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

/** Every file of a new project: the skeleton and the `hello` plugin, paths relative to the project. */
export function renderProject(
	substitutions: Substitutions,
	dir = TEMPLATES_DIR,
): Rendered[] {
	if (!existsSync(dir)) throw new Error(`templates are missing: ${dir}`);
	const values = {
		PROJECT: substitutions.project,
		VERSION: substitutions.version,
	};
	const skeleton = filesUnder(dir)
		.map((file) => relative(dir, file))
		.flatMap((path) =>
			path.startsWith(`${PLUGIN_DIR}/`) || path.startsWith(`${OFFICIAL_DIR}/`)
				? []
				: [
						{
							path: targetOf(path),
							content: fill(readFileSync(join(dir, path), "utf8"), values),
						},
					],
		);
	return [...skeleton, ...renderPlugin(pluginNames("hello"), dir)];
}

/** Writes rendered files under `root`, creating directories; the caller has checked that none exists. */
export function writeRendered(root: string, files: readonly Rendered[]): void {
	for (const file of files) {
		const target = join(root, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.content);
	}
}
