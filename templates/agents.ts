import type { AgentSeed } from "pi-roundtable";

// Ids come from .env, which Bun loads on its own.
const env = (name: string): string => process.env[name] ?? "";

// The first team. An agent that is already stored is never overwritten, so edit agents in Discord afterwards.
export const agents: AgentSeed[] = [
	{
		name: "guide",
		displayName: "Guide",
		prompt:
			"You are Guide, a friendly assistant. Answer briefly and ask when a request is unclear.",
		avatarPrompt: "A friendly lighthouse keeper with a warm lantern",
		// The agent in the entry channel is the coordinator: it answers there and can create the others.
		channelId: env("DISCORD_ENTRY_CHANNEL_ID"),
	},
];
