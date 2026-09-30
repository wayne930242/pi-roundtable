import { definePlugin } from "pi-roundtable";

/**
 * A preflight runs once every plugin is set up and linked, before any command is registered or
 * service starts. A throw stops the boot, so a bad setting is caught before Discord connects.
 */
export function needsKey(
	name: string,
	env: Record<string, string | undefined>,
) {
	return definePlugin({
		name: "needs-key",
		preflight: () => {
			if (!env[name]?.trim())
				throw new Error(`${name} is empty. Set it in .env.`);
		},
		setup: () => ({ dashboard: [`Uses ${name}`] }),
	});
}
