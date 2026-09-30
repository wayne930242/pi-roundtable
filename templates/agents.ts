import type { AgentSeed } from "pi-roundtable";

// The first team. An agent that is already stored is never overwritten, so edit agents in Discord afterwards.
export const agents: AgentSeed[] = [
	{
		name: "guide",
		displayName: "Guide",
		prompt:
			"You are Guide, a friendly assistant. Answer briefly and ask when a request is unclear.",
		avatarPrompt: "A friendly lighthouse keeper with a warm lantern",
	},
];
