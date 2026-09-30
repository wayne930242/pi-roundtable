import { CONFIG_FILE, type Project } from "../project.ts";
import { fail, ok, type Result } from "../report.ts";

/** The configuration against its schema: the failing key is named by the schema's own message. */
export async function checkConfiguration(project: Project): Promise<Result> {
	const assembled = await project.assembled();
	return assembled.ok ? ok(`${CONFIG_FILE} is valid`) : assembled.failure;
}

/** Every plugin has its own name, the operator's and the built-ins' together. */
export async function checkPlugins(project: Project): Promise<Result> {
	const assembled = await project.assembled();
	if (!assembled.ok)
		return { status: "skipped", reason: "the configuration is not valid yet" };
	const seen = new Set<string>();
	for (const { name } of assembled.value.defined.plugins) {
		if (seen.has(name))
			return fail(
				`two plugins are named ${name}.`,
				"Rename yours: a plugin's name is in its definePlugin call, and the built-in plugins already use theirs.",
			);
		seen.add(name);
	}
	const own = assembled.value.config.plugins.map((plugin) => plugin.name);
	return ok(
		own.length === 0 ? "no plugins of your own" : `yours: ${own.join(", ")}`,
	);
}
