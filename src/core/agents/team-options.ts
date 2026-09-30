import type { ChannelKey } from "../domain/conversation.ts";
import type { ThinkingSetting } from "../models.ts";
import type { SkillRegistry } from "../modules/skills/skill-registry.ts";
import type { PromptSection } from "../plugin.ts";
import type { ToolSelection } from "../sessions.ts";
import type { AgentChannels, AgentModels } from "./agent-ports.ts";
import type { AgentGroup, AgentSeed } from "./agent-store.ts";
import type { AvatarStudio } from "./avatar-studio.ts";
import type { TeamTurns, TeamTurnsOptions } from "./team-turns.ts";

export interface AgentTeamOptions
	extends Omit<TeamTurnsOptions, "selection" | "changed"> {
	/** The agent server; its entry channel is where the coordinator lives. */
	guildId: string;
	/** The first team, read and inserted once on start; an agent already stored is never overwritten. */
	seeds: () => readonly AgentSeed[];
	/** Sections the plugins add to every agent turn's system prompt, read before each run. */
	promptSections?: () => readonly PromptSection[];
	/** The tools plugins defined for agents, read before each agent turn. */
	pluginTools?: () => readonly string[];
	channels: AgentChannels;
	studio: Pick<AvatarStudio, "url" | "draw" | "edit">;
	/** The tools and groups the plugins give every agent, read before each agent turn. */
	pluginSelection: () => ToolSelection;
	models: AgentModels;
	schedules: {
		forChannel(channel: ChannelKey): Promise<{ id: number }[]>;
		remove(id: number, channel?: ChannelKey): Promise<unknown>;
	};
	/** The shell's shared working directory. */
	workDir: string;
	/** The host account the agents' shell and file tools run as. */
	shellUser: string;
	/** The prompt every persona shares, the assistant's included; each agent's starts with it. */
	sharedPrompt: string;
	/** The shared prompt for speakers other than the owner, when `sharedPrompt` speaks to the owner. */
	guestPrompt?: string;
	/** The skill registry: what each agent carries and the skill tools. */
	skills: SkillRegistry;
}

/** What the team's collaborators share: its options, its turns, and its change signal. */
export interface TeamContext {
	readonly options: AgentTeamOptions;
	readonly turns: TeamTurns;
	/** Called when a turn starts or ends and when an agent or group changes. */
	changed(): void;
	/** The model and thinking setting of an agent's next run. */
	modelOf(name: string): { model: string; thinking: ThinkingSetting };
	/** Writes a group's members and host into its channel topic, without waiting on Discord. */
	retitle(group: AgentGroup): void;
}
