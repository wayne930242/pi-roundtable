import type {
	ActorFacts,
	ChannelKey,
	Logger,
	OwnerAnswer,
	QuestionnaireAnswer,
	Tier,
} from "pi-roundtable";
import type { ClosedCard, PromptFrame, ServerFrame } from "../api-types.ts";

/** Who answers: an owner visitor, at their tier as of the answer. */
export interface Answerer {
	principalId: string;
	tier: Tier;
	/** The identity they spoke as, `<provider>:<subject>`. */
	speakerId: string;
	name: string;
	/** The roles their sign-in carried. */
	roles?: readonly string[];
	/** The actor their credential vouched for, which a message they start is written as. */
	actor?: ActorFacts;
}

export interface OwnerDeskOptions {
	/** Puts a frame about a room on the sockets that may have it: the owners' for an agent room, the room's readers' for a host room. */
	broadcast(frame: ServerFrame, room: ChannelKey): void;
	/** How long a turn that can be resumed waits on its card before it goes on without the answer. */
	graceMs: number;
	/** A card nobody answers closes after this long; default 24 hours. */
	ttlMs?: number;
	/**
	 * Starts a turn in a room with a late answer's text, as a message from whoever answered. A
	 * rejection is logged.
	 */
	resume(room: ChannelKey, by: Answerer, text: string): void | Promise<void>;
	/**
	 * Keeps a card that ended, for the room's history; called once per card, as it closes. A throw
	 * or a rejection is logged and never reaches the turn.
	 */
	closed?(card: ClosedCard): void | Promise<void>;
	/** Hears of a card when it opens, once; the late re-send of a card does not call it again. Never throws into the turn. */
	opened?(room: ChannelKey, frame: PromptFrame): void;
	/** Display names of principals, for a card that names who may approve it. */
	namesOf(principalIds: readonly string[]): Promise<string[]>;
	logger: Logger;
}

/** What an answer, once checked, says. */
export type Ended =
	| { type: "approval"; approved: boolean }
	| { type: "answer"; answer: OwnerAnswer }
	| { type: "answers"; answer: QuestionnaireAnswer }
	/** The question card's Cancel. */
	| { type: "cancel" };

export interface Open {
	room: ChannelKey;
	frame: PromptFrame;
	/** Whether this person may answer the card. */
	admits(from: Answerer): boolean;
	end(ended: Ended, by: Answerer): void;
	/** Ends the card without an answer, as a stopped turn does. */
	abandon(): void;
}

/** What a card gives the turn that waits on it, and what a late answer says to a new turn. */
export interface Card<T> {
	room: ChannelKey;
	frame: PromptFrame;
	signal: AbortSignal | undefined;
	supersede: AbortSignal | undefined;
	/** Present when the turn may stop waiting: what it is told then. */
	pending?: T;
	/** How long the turn waits before `pending`, in ms, in place of the desk's `graceMs`. */
	graceMs?: number;
	cancelled: T;
	expired: T;
	admits(from: Answerer): boolean;
	/** The turn's result for an answer given while it still waits. */
	valueOf(ended: Ended): T;
	/** A hook before an approval resolves `approved`. */
	approved?(by: Answerer, prompt: string): void;
	/** The text a late answer starts a turn with; undefined starts none. */
	lateText?(ended: Ended, by: Answerer, prompt: string): string | undefined;
}
