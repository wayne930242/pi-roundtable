import { Roundtable } from "../../core/host.ts";
import { silentLogger } from "../../core/log.ts";
import { CONFIG_FILE, type Project } from "../project.ts";
import { fail, ok, type Result } from "../report.ts";

/** The configuration against its schema: the failing key is named by the schema's own message. */
export async function checkConfiguration(project: Project): Promise<Result> {
	const assembled = await project.assembled();
	return assembled.ok ? ok(`${CONFIG_FILE} is valid`) : assembled.failure;
}

/**
 * Every plugin has its own name, the operator's and the built-ins' together, and the plugins
 * register as `start` would register them: each set up, each adding something, none clashing,
 * without a database, a listener or Discord.
 */
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
	try {
		// A definition of its own: the one `start` runs must not have had its plugins set up.
		const defined = await project.reassemble();
		// The plugins' own log lines are the boot's to print, not the check's.
		await new Roundtable(
			{ ...defined.options, logger: silentLogger() },
			defined.plugins,
		).check();
	} catch (error) {
		return fail(
			error instanceof Error ? error.message : String(error),
			`Fix the plugin the message names in ${CONFIG_FILE}, or remove it: \`roundtable start\` would refuse it the same way.`,
		);
	}
	const own = assembled.value.config.plugins.map((plugin) => plugin.name);
	return ok(
		own.length === 0 ? "no plugins of your own" : `yours: ${own.join(", ")}`,
	);
}
