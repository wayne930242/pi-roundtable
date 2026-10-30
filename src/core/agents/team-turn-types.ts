import type { QueuePort } from "../contract/channels.ts";
import type { SurfacePort } from "../contract/surface.ts";
import type { TurnAttachments } from "../domain/attachment.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	TurnResult,
} from "../domain/conversation.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { IdentityService } from "../identity/identity-port.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { Logger } from "../log.ts";
import type { EventSink } from "../plugin.ts";
import type { AvatarStudio } from "../services.ts";
import type { TurnSelection } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type {
	DispatchThread,
	DispatchThreads,
} from "../threads/dispatch-threads.ts";
import type { ToolTiers } from "../tool-tiers.ts";
import type { AgentChannels, AgentTurnRunner } from "./agent-ports.ts";
import type { Agent, PgAgentStore } from "./agent-store.ts";
import type { RelevanceScorer } from "./group-round.ts";

/** Agent messages without an owner message in between (spec behavior 13). */
export const MAX_CHAIN_MESSAGES = 8;
export const BACKLOG_LIMIT = 40;

/** A run of agent messages started by one owner message, schedule, or report. */
export interface Chain {
	messages: number;
	/** Whoever started the run; the agents it wakes work for the same person. */
	speaker: Speaker;
}

/** A message's thread in the sender's turn channel, which holds the request and the answer. */
export interface Exchange {
	parent: ChannelKey;
	thread: DispatchThread;
}

export interface TeamTurnsOptions {
	/** The agent server's entry channel, where the coordinator lives; absent on a host without Discord. */
	entryChannelId?: string;
	/**
	 * The coordinator's name on a host without Discord, where there is no entry channel to find it
	 * by; a function is asked each time, for a name that is only known once the plugins linked.
	 * Ignored when `entryChannelId` is set.
	 */
	coordinator?: string | (() => string | undefined);
	/** Who the agents work for, as their prompts and group history name them. */
	owner: OwnerIdentity;
	store: PgAgentStore;
	/** The Discord channels the agents post in; absent on a host without Discord, where every reply goes through a room's surface. */
	channels?: Pick<AgentChannels, "post" | "interim">;
	/**
	 * The surfaces that host agent rooms. A reply in a room goes through `sendReply` with the
	 * agent as author, and its interim posts through `interim`, never through the Discord
	 * channels; without it no key but Discord's is the team's. `of` tells whether the room's
	 * surface carries reply files.
	 */
	surfaces?: Pick<
		SurfacePort,
		"sendReply" | "interim" | "roomSurfaces" | "of" | "progress"
	>;
	studio: Pick<AvatarStudio, "url">;
	/** Set once the runtime exists, which itself needs the team's tools. */
	runtime: () => AgentTurnRunner;
	/** The tools every agent turn runs with. */
	selection: (scope: AgentTurnScope) => TurnSelection;
	/** The lowest tier that may use each tool, which also decides who may approve a held one. */
	toolTiers?: ToolTiers;
	/** Judges whether an owner message approves held actions. */
	confirmations: {
		approves(pending: PendingConfirmation, reply: string): Promise<boolean>;
	};
	scorer: Pick<RelevanceScorer, "score">;
	/** Shared with the conversation service, so each channel runs one turn at a time. */
	queue: QueuePort;
	startTyping(channel: ChannelKey): () => void;
	/** The owner's stop button for a turn in an agent's own channel, until the returned function is called. */
	showStop(channel: ChannelKey): () => void;
	logger: Logger;
	/** Called when a turn starts or ends. */
	changed(): void;
	/** Where turns and team changes are reported for the plugins' handlers. */
	events?: EventSink;
	/**
	 * The identity service, read when a kept agent message is replayed: its speaker runs again only
	 * as a principal that still exists and is enabled, at no more than its tier now. Without one, the
	 * stored speaker is kept.
	 */
	principals?: () => Pick<IdentityService, "speakerFor"> | undefined;
	/** A thread for each message between agents; without it both go in the sender's channel. */
	threads?: Pick<DispatchThreads, "open">;
}

/** How a turn runs, beyond its text. */
export interface TurnExtra {
	attachments?: TurnAttachments;
	confirmed?: boolean;
	steerable?: boolean;
	/** A person's message started it. */
	byMessage?: boolean;
	/** The owner started it by writing, or it delivers a report, so it may ask them on cards. */
	interactive?: boolean;
	/** No person waits on the answer, so an empty one is no failure. */
	unattended?: boolean;
	/** How long the turn may work, in ms, in place of the default; a schedule's own limit. */
	timeLimitMs?: number;
}

/** The fields of `extra` that a turn request carries, left out where unset. */
export function turnFlags(extra: TurnExtra) {
	return {
		...(extra.attachments ? { attachments: extra.attachments } : {}),
		...(extra.confirmed ? { confirmed: true } : {}),
		...(extra.steerable ? { steerable: true } : {}),
		...(extra.byMessage ? { byMessage: true } : {}),
		...(extra.interactive ? { interactive: true } : {}),
		...(extra.unattended ? { unattended: true } : {}),
		...(extra.timeLimitMs === undefined
			? {}
			: { timeLimitMs: extra.timeLimitMs }),
	};
}

/** What the team's message and group collaborators need of the turns that own their state. */
export interface TurnHost {
	readonly options: TeamTurnsOptions;
	/** The chain of each running turn, by session key. */
	readonly chains: ReadonlyMap<ChannelKey, Chain>;
	/** Runs one agent turn and posts its reply under the agent's name; never rejects. */
	turn(
		agent: Agent,
		scope: AgentTurnScope,
		postTo: ChannelKey,
		text: string,
		chain: Chain,
		extra?: TurnExtra,
	): Promise<TurnResult>;
	post(
		channel: ChannelKey,
		as: Agent,
		body: { thinking?: string; chunks: string[]; threadId?: string },
	): Promise<void>;
	/** The agent's latest row. */
	current(agent: Agent): Agent;
	/** Whether the speaker's tier holds every tool of the held actions. */
	mayApprove(speaker: Speaker, pending: PendingConfirmation): boolean;
	turnChannel(scope: AgentTurnScope): ChannelKey;
}
