import type { CharacterInput } from "../../characters/index.ts";
import type {
	HelperFields,
	PresetAction,
} from "../agents/helper-preset-ops.ts";
import type { AgentTurnScope } from "../domain/ports.ts";

/**
 * Discord's side of `AgentOps.arrange` and `AgentOps.read`, which the host hands the team while
 * the two stay on `AgentOps`: what the Discord plugin's `channel_arrange` and `channel_read` run.
 */
export type FormerChannelOps = Pick<AgentOps, "arrange" | "read">;

/**
 * What the agent tools do; the agent team implements it. Each returns text for the model.
 * `arrange`, `read`, and the `category` of `create` and `createGroup` are what 0.45 had: the
 * Discord plugin's own tools and its `category` argument took their place, and they stay here,
 * deprecated, until 1.0.
 */
export interface AgentOps {
	list(): Promise<string>;
	get(name: string): string;
	update(
		name: string,
		change: {
			displayName?: string;
			prompt?: string;
			model?: string;
			thinking?: string;
		},
		/** Who changes it: the agent whose turn asks, for the prompt history. */
		by?: string,
	): Promise<string>;
	create(
		caller: AgentTurnScope,
		input: {
			name: string;
			displayName: string;
			prompt: string;
			/** Fields of its look; any left out come from the look its role suggests. */
			character?: CharacterInput;
			task: string;
			/** @deprecated Discord's category for its channel; give it as `hints.category`. Removed in 1.0. */
			category?: string;
			/** The values of the arguments the surfaces' place providers add to the tool, by name. */
			hints?: Readonly<Record<string, string>>;
			skills?: string[];
			/** Turn long-running mode on for its conversations; an owner's turn only. */
			longRunning?: boolean;
		},
	): Promise<string>;
	/** Makes a temp knight of the caller for one task; the answer returns to the caller's conversation. */
	helperCreate(
		caller: AgentTurnScope,
		input: HelperFields & { name?: string; task: string },
	): Promise<string>;
	/** Saves, lists, or deletes the caller's own temp-knight presets. */
	helperPreset(caller: AgentTurnScope, action: PresetAction): Promise<string>;
	/** Archives the caller's own temp knights: the named ones, or every one that is finished. */
	helperEnd(
		caller: AgentTurnScope,
		names: readonly string[] | "finished",
	): Promise<string>;
	/** Changes an agent's look; a field left out stays as it is. */
	avatar(name: string, look: CharacterInput): Promise<string>;
	/** Queues the message and returns at once. */
	/**
	 * Hands a request to another agent, in its conversation on the sender's surface, or in the
	 * `conversation` named: "discord", "web" (or a room surface's name), or one of its conversation keys.
	 */
	message(
		caller: AgentTurnScope,
		to: string,
		text: string,
		conversation?: string,
	): string;
	/**
	 * Readies the place a message is about to reach: a temp knight made in the web app gets its
	 * Discord thread when the caller may message it and names "discord". Never rejects.
	 */
	reach?(
		caller: AgentTurnScope,
		to: string,
		conversation?: string,
	): Promise<void>;
	createGroup(input: {
		name: string;
		displayName: string;
		members: string[];
		host?: string;
		/** @deprecated Discord's category for its channel; give it as `hints.category`. Removed in 1.0. */
		category?: string;
		/** The values of the arguments the surfaces' place providers add to the tool, by name. */
		hints?: Readonly<Record<string, string>>;
	}): Promise<string>;
	updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<string>;
	archive(caller: AgentTurnScope, name: string): Promise<string>;
	/**
	 * Sorts the agent guild's channels into categories, as the Discord plugin's `channel_arrange`
	 * tool does; refused on a host whose team has no Discord channels.
	 * @deprecated The Discord plugin contributes `channel_arrange`, which an agent's turn carries;
	 * a plugin that arranges channels itself uses `DISCORD.connection.agentChannels`. Removed in 1.0.
	 */
	arrange(entries: { category: string; names: string[] }[]): Promise<string>;
	/**
	 * Reads a channel's messages, as the Discord plugin's `channel_read` tool does; refused on a
	 * host whose team has no Discord channels.
	 * @deprecated The Discord plugin contributes `channel_read`, which an agent's turn carries; a
	 * plugin that reads channels itself uses `DISCORD.connection.agentChannels`. Removed in 1.0.
	 */
	read(
		channel: string,
		around: string | undefined,
		limit: number | undefined,
	): Promise<string>;
}
