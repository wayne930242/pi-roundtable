import type { AgentSeed } from "../agents/agent-rules.ts";
import type { RoundtablePlugin } from "../plugin.ts";

/** The configured first team, created on the first start; an agent already stored is never overwritten. */
export function seedsPlugin(agents: readonly AgentSeed[]): RoundtablePlugin {
	return {
		name: "seeds",
		setup: () => ({ seeds: agents }),
	};
}
