import type { AgentRuntime, ContextUse } from "../contract/runtime.ts";
import type { InterimPosts } from "../domain/interim.ts";
import type { ThinkingSetting } from "../models.ts";

export type { ContextUse };

/** The part of the runtime the agent team drives. */
export type AgentTurnRunner = Pick<
	AgentRuntime,
	"runTurn" | "heldActions" | "startFresh" | "contextUsage"
>;

/** One agent's message in a channel, posted under its name and avatar. */
export interface AgentPost {
	name: string;
	avatarUrl: string;
	/** The turn's thinking, posted first as a quiet line. */
	thinking?: string;
	chunks: string[];
	files?: { name: string; data: Uint8Array }[];
	/** A thread of the channel to post in instead, such as a dispatch's. */
	threadId?: string;
}

/**
 * A category's name. Agents live under `Agents` or `Agents-<suffix>`, groups under `Groups` or
 * `Groups-<suffix>`, and archived ones, kept with their history, under `Archive`.
 */
export type AgentCategory = string;

/** A category of the agent server and its channels, in server order. */
export interface CategoryLayout {
	/** Absent for a category still to be made. */
	id?: string;
	name: string;
	channelIds: string[];
}

/** A message of the agent server as `channel_read` returns it. */
export interface ChannelMessage {
	id: string;
	author: string;
	at: Date;
	text: string;
	attachments: string[];
}

/** The agent server's channels as the agent team needs them. */
export interface AgentChannels {
	post(channelId: string, post: AgentPost): Promise<void>;
	/**
	 * Where a running turn posts the text it writes before its final answer, under the same name
	 * and avatar as `post`; absent = only the final reply is posted.
	 */
	interim?(
		channelId: string,
		as: Omit<AgentPost, "thinking" | "chunks" | "files">,
	): InterimPosts;
	/** Creates a text channel under the category, made when missing; returns its id. */
	createChannel(
		name: string,
		topic: string,
		category: AgentCategory,
	): Promise<string>;
	/** Moves a channel into the category when it sits elsewhere; true when it moved. */
	placeIn(channelId: string, category: AgentCategory): Promise<boolean>;
	/** Every category of the server in order, each with its channels in order. */
	layout(): Promise<CategoryLayout[]>;
	/**
	 * Puts the categories, and the channels in each, in this order, making categories without an
	 * id; then deletes the categories of `remove` that hold no channel.
	 */
	arrange(layout: CategoryLayout[], remove: string[]): Promise<void>;
	setTopic(channelId: string, topic: string): Promise<void>;
	/** Deletes the assistant's webhook in the channel, when it has one; its past messages stay. */
	removeWebhook(channelId: string): Promise<void>;
	exists(channelId: string): Promise<boolean>;
	/**
	 * Up to `limit` messages of a text channel or thread of the agent server, oldest first: the
	 * latest, or those around `around`. Other servers' channels are refused.
	 */
	read(
		channelId: string,
		options: { limit: number; around?: string },
	): Promise<ChannelMessage[]>;
}

/** The dashboard channel's one pinned message, made when missing and edited in place. */
export interface DashboardBoard {
	show(sections: string[]): Promise<void>;
}

/** The models an agent can run on, and the assistant's own, which unset agents follow. */
export interface AgentModels {
	/** The assistant's thinking is `auto`: the judge picks each turn's level. */
	defaults: { model: string; thinking: ThinkingSetting };
	/** Every model the host can run, as `<provider>/<id>`. */
	usable(): Promise<string[]>;
}
