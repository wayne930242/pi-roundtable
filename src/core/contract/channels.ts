import type { Locale } from "../i18n/index.ts";
import type { ActorFacts } from "../identity/actor-facts.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker, Tier } from "../speakers.ts";

/** A file attached to a chat message, as the surface reports it; nothing is downloaded yet. */
export interface AttachmentRef {
	url: string;
	name: string;
	/** MIME type when the surface knows it. */
	contentType?: string;
	size: number;
}

/** The facts a surface reports about one incoming message; it never decides who may talk. */
export interface InboundMessage {
	channel: ChannelKey;
	/** Unique per surface; keeps the files of different messages apart. */
	messageId: string;
	/**
	 * Who wrote it, as the surface reports them: the router resolves them to `speaker` through the
	 * identity service. A surface that leaves it out has it read from `authorId`, `authorName`, and
	 * `authorRoleIds` under its own name as the provider, with a `deprecated` warning; that goes
	 * away in 1.0.
	 */
	actor?: ActorFacts;
	/**
	 * Who the author is, with their principal and tier, as the router resolved them before any
	 * claim admits the message: undefined when the access rules serve no one by them, and for a bot
	 * or an integration, which are not resolved. Only the router sets it; a surface's own value is
	 * dropped. A claim that serves only people the host serves answers only when it is set.
	 */
	speaker?: Speaker;
	/** The id the surface knows the author by; who they are to the host is `speaker`. */
	authorId: string;
	/** How the author appears in the channel, for example a server nickname. */
	authorName: string;
	authorIsBot: boolean;
	/** The roles the author holds in the message's space; absent in direct messages. */
	authorRoleIds?: readonly string[];
	/**
	 * The server or workspace the channel belongs to, in the surface's own ids; absent in a
	 * direct conversation.
	 */
	space?: string;
	isDirect: boolean;
	/**
	 * Set when an integration posted the message, such as a Discord webhook; its name is
	 * `authorName`. `own` says the integration is one the assistant posts through itself, such as an
	 * agent's voice.
	 */
	integration?: { id: string; own: boolean };
	mentionsBot: boolean;
	/** The message replies to one of the bot's messages. */
	repliesToBot: boolean;
	/** Message text with the bot mention removed. */
	text: string;
	attachments: AttachmentRef[];
	/** The message this one replies to, as far as the surface can read it. */
	reference?: {
		text: string;
		attachments: AttachmentRef[];
		/** The name a webhook posted the referenced message under, such as an agent's. */
		webhookName?: string;
	};
	/** The message the author forwarded with this one; its attachments are in `attachments`. */
	forwarded?: {
		text: string;
		/** The channel the message was forwarded from. */
		source: ChannelKey;
		/** A link to the original message. */
		url: string;
	};
}

/** Reactions on a message sent during a turn: added to that turn, or waiting for its own. */
export const STEERED_MARK = "↪️";
export const QUEUED_MARK = "⏳";

/** How a turn nobody wrote in the channel ended. */
export type ScheduledOutcome =
	| { status: "ran" }
	| { status: "failed"; error: string }
	| { status: "skipped"; reason: string };

/**
 * Whose turn a schedule or a delegated task asks for, contributed by the plugin whose claim
 * answers it. The target also sets the limits of what may be scheduled or delegated for it, so a
 * channel open to many people can be held tighter than the owner's own.
 */
export interface BackgroundTarget {
	/** Stored on schedules and delegated jobs; unique across plugins, as a persona's kind is. */
	name: string;
	/** How lists such as `/<root> schedule` name it, in the host's locale. */
	label(locale: Locale): string;
	/**
	 * Limits of the schedules made for it; absent, nothing may be scheduled for it. `perPrincipal`,
	 * when set, holds each person to that many of its schedules across all their conversations.
	 */
	schedules?: {
		perChannel: number;
		perPrincipal?: number;
		promptChars: number;
		aheadDays: number;
	};
	/**
	 * Limits of the delegated tasks reporting to it; absent, nothing may be delegated to it.
	 * `maxRunningPerPrincipal`, when set, holds each person to that many running at once across
	 * all their conversations.
	 */
	delegation?: { maxRunning: number; maxRunningPerPrincipal?: number };
}

/** A turn nobody wrote in the channel: a schedule's, or a report of work done elsewhere. */
export interface BackgroundTurn {
	channel: ChannelKey;
	/**
	 * The name of the `BackgroundTarget` the turn is for. The router skips a turn whose target no
	 * plugin contributes, and a claim skips one it does not serve.
	 */
	target: string;
	/**
	 * Whom the turn is for: the principal who set up the work, and the id and name they are shown
	 * by, such as the identity they spoke as. The system principal is the host's alone.
	 */
	author: { principalId: string; id: string; name: string };
	/**
	 * The tier the turn asks to run at, its creator's when they set it up. It runs at that tier or
	 * the principal's own now, whichever is lower.
	 */
	tier: Tier;
	turnId: string;
	text: string;
	/** It delivers a report the owner is waiting for, so it may ask them on cards. */
	report?: boolean;
	/**
	 * Who the turn runs as, set by the router alone once it checked the author: their principal
	 * exists and is not disabled, and the tier is capped at theirs. A claim runs the turn as this
	 * speaker; one the caller sets is replaced.
	 */
	speaker?: Speaker;
}

/** Who a background turn runs as, once checked; or why it may not run now. */
export type BackgroundRunsAs = { speaker: Speaker } | { skipped: string };

/**
 * Whose conversation a channel holds, as the claim that owns it names it when `startFresh` says
 * whose it was: any string, such as "owner" or "study". The host reads none of them, so a plugin
 * narrows the kinds of its own claims itself.
 */
export type ConversationKind = string;

/** What a claim does with a message in a channel it owns. */
export type Admission =
	| {
			kind: "turn";
			/**
			 * When the channel is busy: whether the message is marked, and first offered to the
			 * running turn with `steer`, which says whether the turn took it.
			 */
			busy?: {
				steer?(): Promise<boolean>;
				react(emoji: string): Promise<void>;
				unreact(emoji: string): Promise<void>;
			};
			/** The turn, run in the channel's queue. */
			run(): Promise<void>;
			/**
			 * Called instead of `run` when the router drops the message the claim admitted, because
			 * its author, once recorded, was not who they were when admitted; frees what the claim
			 * holds for it.
			 */
			dropped?(): void;
			/** The log line when the turn throws. */
			failure: string;
	  }
	| {
			kind: "background";
			turn: BackgroundTurn;
			/** Called when the turn did not run. */
			unanswered(outcome: ScheduledOutcome): void;
	  };

/**
 * One plugin's channels. The router asks the claims by descending priority, then registration
 * order, and the first that owns a channel decides everything there: a message it does not
 * admit is dropped, never passed to a lower claim. Each operation runs inside the channel's
 * queue, so none of them queues itself.
 */
export interface ChannelClaim {
	name: string;
	priority: number;
	/** Whether the claim owns the channel; `space` is the message's space, when routing one. */
	owns(channel: ChannelKey, space?: string): boolean;
	/** What to do with a message in an owned channel; undefined drops it. */
	admit(message: InboundMessage): Admission | undefined;
	/** A background turn in an owned channel; a claim without one skips them. */
	background?(turn: BackgroundTurn): Promise<ScheduledOutcome>;
	/** Starts the channel's conversation over, saying whose it was. */
	startFresh(channel: ChannelKey): Promise<string>;
	/**
	 * Stops the channel's running turn; true when one was running. The router asks only the claim
	 * that owns the channel, and a claim without `stop` has nothing to stop there.
	 */
	stop?(channel: ChannelKey): boolean;
	/** Removes the channel's conversation for good; a claim without one refuses. */
	deleteConversation?(channel: ChannelKey): Promise<void>;
	/** Reports of work started in an owned channel stay in it instead of opening a thread. */
	postsInPlace?: boolean;
	/**
	 * Whether the claim's `background` answers the host's own turns (`SYSTEM_PRINCIPAL`), such as
	 * `ops.conversation`'s error reports, in its conversations; true when left out. A claim whose
	 * conversations are each private to the person who opened them, such as the web chat's, says
	 * false, and a host whose `ops.conversation` names one of them does not start.
	 */
	takesSystemReports?: boolean;
}

/** The conversations of every claimed channel, through the channel queue. */
export interface ConversationPort {
	/** Never rejects; resolves when the message's turn is done or dropped. */
	handle(message: InboundMessage): Promise<void>;
	/**
	 * Runs a turn nobody wrote, as its author's principal at the lower of its tier and theirs; it
	 * is skipped, with the reason, when the principal is unknown, disabled, holds no tier, or was
	 * last seen too long ago (`access.backgroundStaleDays`), or when the turn names no principal or
	 * tier. Never rejects.
	 */
	background(turn: BackgroundTurn): Promise<ScheduledOutcome>;
	/**
	 * Who a background turn would run as now, checked as `background` checks it, without running
	 * it: for work that must not happen for an author who may not run the turn, such as a
	 * schedule's precheck. Throws when the identity service cannot tell.
	 */
	runsAs(turn: BackgroundTurn): Promise<BackgroundRunsAs>;
	/** A contributed background target, read when used; undefined when no plugin contributes it. */
	target(name: string): BackgroundTarget | undefined;
	/** Waits for the channel's running turn, then starts its conversation over; says whose it was. */
	startFresh(channel: ChannelKey): Promise<string>;
	/** `busy` while a turn runs or waits in the channel. */
	deleteConversation(channel: ChannelKey): Promise<"deleted" | "busy">;
	/** Stops the channel's running turn; false when none runs. */
	stop(channel: ChannelKey): boolean;
	/** Whether reports of work started in the channel stay in it, by its owner's policy. */
	postsInPlace(channel: ChannelKey): boolean;
	/** Whether a claim owns the channel, so its messages and background turns reach a conversation. */
	owns(channel: ChannelKey): boolean;
	/** Whether the claim that owns the channel runs background turns there; false when none owns it. */
	takesBackground(channel: ChannelKey): boolean;
	/** Whether the claim that owns the channel takes the host's own turns; false when none owns it. */
	takesSystemReports(channel: ChannelKey): boolean;
}

/** The host's channel queue, as plugins use it. */
export interface QueuePort {
	run<T>(channel: ChannelKey, task: () => Promise<T>): Promise<T>;
	/** Tasks of the channel running or waiting. */
	size(channel: ChannelKey): number;
	/** Channels with a task running or waiting. */
	busy(): ChannelKey[];
	/**
	 * Whether the host is shutting down: a task that has not started is then refused with
	 * HostStoppingError, and a plugin that starts work on its own, such as a timer, starts none.
	 */
	readonly closed: boolean;
	/** Called whenever a channel's count of running and waiting tasks changes. */
	onChange(listener: (channel: ChannelKey) => void): void;
}
