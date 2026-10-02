import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addPluginToConfig, ConfigEditError } from "./config-edit.ts";
import type { PackagePorts } from "./pi-packages.ts";
import {
	isPluginName,
	pluginNames,
	renderPackagePlugin,
	writeRendered,
} from "./templates.ts";

const CONFIG = "roundtable.config.ts";

export interface AddPackageInputs {
	cwd: string;
	/** What `bun add` takes from the registry: a name, optionally scoped, optionally with `@<version>`. */
	spec: string;
	ports: PackagePorts;
	/** Where the templates are; default the package's own. */
	templates?: string;
}

export interface AddPackageReport {
	ok: boolean;
	problems: string[];
	/** Paths written or changed, relative to `cwd`; `package.json` once the package is installed. */
	changed: string[];
	/** The tools the package registers, in the order its extensions register them. */
	tools: string[];
}

const refused = (
	problems: string[],
	changed: string[] = [],
): AddPackageReport => ({ ok: false, problems, changed, tools: [] });

/** A registry spec: an optional `@scope/`, the name, and an optional `@<version or tag>`. */
const SPEC = /^((?:@[a-z0-9][a-z0-9._-]*\/)?([a-z0-9][a-z0-9._-]*))(?:@(.+))?$/;

/**
 * Installs the Pi package `spec`, finds the tools its extensions register, and writes
 * `plugins/<name>.ts` and its test, named after the package without its scope: the plugin loads
 * the package in every session and gives every agent turn its tools, which stay the owner's
 * until the operator's `toolTiers` lowers one. Everything that can be checked without the package is checked before `bun add` runs,
 * so those refusals leave the project untouched; a package that fails to load after it is
 * installed is reported with the command that removes it.
 */
export async function addPackage(
	inputs: AddPackageInputs,
): Promise<AddPackageReport> {
	const { cwd, spec, ports } = inputs;
	const parsed = SPEC.exec(spec);
	if (!parsed?.[1] || !parsed[2])
		return refused([
			`${JSON.stringify(spec)} is not a package from the registry. Give its name, such as pi-web-access or @scope/name@1.2.3; install any other kind with bun add and list it in a plugin's piPackages by hand.`,
		]);
	const pkg = parsed[1];
	const name = parsed[2];
	if (!isPluginName(name))
		return refused([
			`the plugin would be named ${JSON.stringify(name)}, which is not lowercase words joined by dashes. Install it with bun add and list it in a plugin's piPackages by hand.`,
		]);
	const configPath = join(cwd, CONFIG);
	if (!existsSync(configPath))
		return refused([
			`${CONFIG} is not in ${cwd}. Run this in the project directory, or create the project with \`roundtable init\`.`,
		]);
	const names = pluginNames(name);
	const paths = [`plugins/${name}.ts`, `plugins/${name}.test.ts`];
	const existing = paths.filter((path) => existsSync(join(cwd, path)));
	if (existing.length > 0)
		return refused([
			`${existing.join(" and ")} already ${existing.length === 1 ? "exists" : "exist"}. Remove the file, or list ${pkg} in that plugin's piPackages by hand.`,
		]);
	let edited: string;
	try {
		edited = addPluginToConfig(readFileSync(configPath, "utf8"), names, CONFIG);
	} catch (error) {
		if (error instanceof ConfigEditError) return refused([error.message]);
		throw error;
	}
	const installed = await ports.install(cwd, spec);
	if (!installed.ok)
		return refused([
			`bun add ${spec} failed; nothing was written.`,
			...(installed.output ? [installed.output] : []),
		]);
	let tools: string[];
	try {
		tools = await ports.tools(cwd, pkg);
	} catch (error) {
		return refused(
			[
				`${error instanceof Error ? error.message : String(error)} No plugin was written; run \`bun remove ${pkg}\` to uninstall it.`,
			],
			["package.json"],
		);
	}
	const files = renderPackagePlugin(names, pkg, tools, inputs.templates);
	writeRendered(cwd, files);
	writeFileSync(configPath, edited);
	return {
		ok: true,
		problems: [],
		changed: ["package.json", ...files.map((file) => file.path), CONFIG],
		tools,
	};
}
