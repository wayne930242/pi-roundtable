import type { Locale } from "../i18n/index.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Tier } from "../speakers.ts";

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
	/** Limits of the schedules made for it; absent, nothing may be scheduled for it. */
	schedules?: { perChannel: number; promptChars: number; aheadDays: number };
	/** Limits of the delegated tasks reporting to it; absent, nothing may be delegated to it. */
	delegation?: { maxRunning: number };
}

/** A turn nobody wrote in the channel: a schedule's, or a report of work done elsewhere. */
export interface BackgroundTurn {
	channel: ChannelKey;
	/**
	 * The name of the `BackgroundTarget` the turn is for. The router skips a turn whose target no
	 * plugin contributes, and a claim skips one it does not serve.
	 */
	target: string;
	author: { id: string; name: string };
	/**
	 * The tier the turn runs at, which is its creator's when a person set it up; absent for
	 * the operator's own automation, which runs at the owner's.
	 */
	tier?: Tier;
	turnId: string;
	text: string;
	/** It delivers a report the owner is waiting for, so it may ask them on cards. */
	report?: boolean;
}

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
}

/** The conversations of every claimed channel, through the channel queue. */
export interface ConversationPort {
	/** Never rejects; resolves when the message's turn is done or dropped. */
	handle(message: InboundMessage): Promise<void>;
	background(turn: BackgroundTurn): Promise<ScheduledOutcome>;
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
}

/** The host's channel queue, as plugins use it. */
export interface QueuePort {
	run<T>(channel: ChannelKey, task: () => Promise<T>): Promise<T>;
	/** Tasks of the channel running or waiting. */
	size(channel: ChannelKey): number;
	/** Channels with a task running or waiting. */
	busy(): ChannelKey[];
	/** Called whenever a channel's count of running and waiting tasks changes. */
	onChange(listener: (channel: ChannelKey) => void): void;
}
