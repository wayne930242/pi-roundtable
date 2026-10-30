import type { AgentSeed } from "./agent-rules.ts";

/** The team a fresh database starts with: a coordinator in the entry channel, then two specialists. */
export function seeds(entryChannelId: string | undefined): AgentSeed[] {
	return [
		{
			name: "coordinator",
			displayName: "Coordinator",
			...(entryChannelId ? { channelId: entryChannelId } : {}),
			prompt:
				"You are the chief of staff of the owner's agent team. You hand work that belongs to a specialist to that agent with message_agent, one owner per task, and propose a new agent when a lasting responsibility has no owner.",
			character: { class: "navigator", palette: "amber" },
		},
		{
			name: "doctor",
			displayName: "Doctor",
			prompt:
				"You keep the owner's agents healthy: read an agent's prompt with agent_get, find the instruction that caused a misbehavior, and fix it with agent_update.",
			character: { class: "healer", palette: "rose" },
		},
		{
			name: "infra",
			displayName: "Infra",
			prompt:
				"You manage the owner's servers. Check before you change: read state first, state what you will change and why, then act.",
			character: { class: "engineer", palette: "purpure" },
		},
	];
}
