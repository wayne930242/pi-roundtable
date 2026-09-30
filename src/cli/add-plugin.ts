import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addPluginToConfig, ConfigEditError } from "./config-edit.ts";
import {
	isPluginName,
	pluginNames,
	renderPlugin,
	writeRendered,
} from "./templates.ts";

const CONFIG = "roundtable.config.ts";

export interface AddPluginInputs {
	cwd: string;
	name: string;
	/** Where the templates are; default the package's own. */
	templates?: string;
}

export interface AddPluginReport {
	ok: boolean;
	problems: string[];
	/** Paths written or changed, relative to `cwd`. */
	changed: string[];
}

const refused = (...problems: string[]): AddPluginReport => ({
	ok: false,
	problems,
	changed: [],
});

/**
 * Creates `plugins/<name>.ts` and its test from the `hello` template and lists the plugin in
 * `roundtable.config.ts`. Everything is checked and rendered before the first write, so a refusal
 * leaves the project untouched.
 */
export function addPlugin(inputs: AddPluginInputs): AddPluginReport {
	const { cwd, name } = inputs;
	if (!isPluginName(name))
		return refused(
			`${JSON.stringify(name)} is not a plugin name. Use lowercase words joined by dashes, such as my-notes.`,
		);
	const configPath = join(cwd, CONFIG);
	if (!existsSync(configPath))
		return refused(
			`${CONFIG} is not in ${cwd}. Run this in the project directory, or create the project with \`roundtable init\`.`,
		);
	const files = renderPlugin(pluginNames(name), inputs.templates);
	const existing = files
		.map((file) => file.path)
		.filter((path) => existsSync(join(cwd, path)));
	if (existing.length > 0)
		return refused(
			`${existing.join(" and ")} already ${existing.length === 1 ? "exists" : "exist"}. Choose another name or remove the file.`,
		);
	let edited: string;
	try {
		edited = addPluginToConfig(
			readFileSync(configPath, "utf8"),
			pluginNames(name),
			CONFIG,
		);
	} catch (error) {
		if (error instanceof ConfigEditError) return refused(error.message);
		throw error;
	}
	writeRendered(cwd, files);
	writeFileSync(configPath, edited);
	return {
		ok: true,
		problems: [],
		changed: [...files.map((file) => file.path), CONFIG],
	};
}
