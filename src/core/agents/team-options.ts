import type { ChannelKey } from "../domain/conversation.ts";
import type { ThinkingSetting } from "../models.ts";
import type { PromptSection } from "../plugin.ts";
import type { AvatarStudio, SkillRegistry } from "../services.ts";
import type { ToolSelection } from "../sessions.ts";
import type { AgentChannels, AgentModels } from "./agent-ports.ts";
import type { AgentGroup, AgentSeed } from "./agent-store.ts";
import type { TeamTurns, TeamTurnsOptions } from "./team-turns.ts";

export interface AgentTeamOptions
	extends Omit<TeamTurnsOptions, "selection" | "changed"> {
	/**
	 * The team's id: the Discord guild, or `LOCAL_TEAM_ID` on a host without Discord. It scopes the
	 * rows the team keeps.
	 */
	guildId: string;
	/** The first team, read and inserted once on start; an agent already stored is never overwritten. */
	seeds: () => readonly AgentSeed[];
	/** Sections the plugins add to every agent turn's system prompt, read before each run. */
	promptSections?: () => readonly PromptSection[];
	/** The tools plugins defined for agents, read before each agent turn. */
	pluginTools?: () => readonly string[];
	/**
	 * The Discord channels the agents live in; absent on a host without Discord. Then no channel is
	 * made, arranged or read, and the agents live in the rooms of the surfaces that host them.
	 */
	channels?: AgentChannels;
	/**
	 * Agents are composed characters, rendered by `render`. `canDraw: false` marks a host without
	 * an image provider, which is not told about generate_image; a studio that leaves it out has one.
	 */
	studio: Pick<AvatarStudio, "url" | "render" | "draw" | "edit"> &
		Partial<Pick<AvatarStudio, "canDraw">>;
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
	/** The scratch dir the agents' shell writes temporary files to. */
	scratchDir?: string;
	/** The prompt every persona shares, the assistant's included; each agent's starts with it. */
	sharedPrompt: string;
	/** The shared prompt for speakers other than the owner, when `sharedPrompt` speaks to the owner. */
	guestPrompt?: string;
	/** The skill registry: what each agent carries. Absent when the skills addon is off. */
	skills?: SkillRegistry;
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
