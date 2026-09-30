import { definePlugin } from "pi-roundtable";

/**
 * The selection names tools every agent turn carries besides its own, read before each turn so
 * a set that changes while the process runs stays current.
 */
export function alwaysOn(tools: () => string[]) {
	return definePlugin({
		name: "always-on",
		setup: () => ({
			agentSelection: () => ({ tools: tools(), groups: [] }),
		}),
	});
}
