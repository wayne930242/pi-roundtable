import type { ConversationVisibility } from "../conversations/conversation-registry.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { Speaker, Tier } from "../speakers.ts";

/**
 * How a prompt ended: answered yes or no; `expired` when no one could answer it (no one's to
 * approve, or the card could not be posted); `cancelled` when its turn stopped; or `pending` when
 * the turn stopped waiting while the card stays open, its answer to come through `PromptWait`.
 */
export type Approval =
	| "approved"
	| "declined"
	| "expired"
	| "cancelled"
	| "pending";

/** An answer given on a prompt after its turn stopped waiting; `by` names who gave it. */
export type LateAnswer = { by: string } & (
	| { kind: "approval"; approved: boolean }
	| { kind: "question"; answer: OwnerAnswer }
);

/**
 * How a prompt may outlive its turn. Given, a surface may stop the turn's wait after a grace
 * period, resolving `pending`, and keep the prompt open; an answer that comes later goes to
 * `late`, and the surface starts a turn in the prompt's conversation with the text `late`
 * returns, as a message from whoever answered (none when it returns undefined). Without it the
 * prompt waits for its answer or its turn's stop.
 */
export interface PromptWait {
	late(answer: LateAnswer): string | undefined;
}

export interface AskOption {
	label: string;
	description?: string;
}

export interface OwnerQuestion {
	question: string;
	/** Up to 25; none means a free-text answer. */
	options: readonly AskOption[];
	/** More than one option may be chosen. */
	multi: boolean;
	/** They may write an answer of their own besides the options. */
	allowOther: boolean;
}

export interface OwnerAnswer {
	/** The chosen options' labels, in the order they were offered. */
	choices: string[];
	/** What they wrote themselves, if anything. */
	text?: string;
}

/**
 * Who may answer a running turn's prompts: the person whose turn asks, and, in a conversation
 * others share, the owners. The runtime makes it from the turn's speaker and the conversation's
 * visibility with `promptScope`.
 */
export interface PromptScope {
	/**
	 * The principal whose turn asks. They are the person who answers on any of their identities:
	 * a surface accepts an answer from each identity it knows of theirs, and, where it has none of
	 * theirs, the prompt is one their tier would not reach.
	 */
	principalId: string;
	/**
	 * The identity that spoke, as `Speaker.id`: whom a surface addresses the prompt to when it is
	 * one of its own, or else every identity it knows of the principal. A background turn's may be
	 * no surface's at all.
	 */
	speakerId: string;
	/**
	 * Their tier when the turn asked; an approval above it is not theirs, and the surface checks it
	 * again when they answer where it can. An owner-tier approval is theirs only when the principal
	 * is an owner: a turn's tier may default to owner without its person being one.
	 */
	tier: Tier;
	/**
	 * Who else may answer: `owners` in a shared conversation, where an approval above the
	 * speaker's tier goes to the owners; `none` in a private one, which no one else sees, so such
	 * an approval expires at once.
	 */
	escalate: "owners" | "none";
}

/**
 * Prompts inside a running turn, on its conversation's surface: an approval of a held action and an
 * `ask_user` question, answered by those its `PromptScope` names. A stopped turn cancels the ones
 * it still waits on; with a `PromptWait`, a prompt may outlive the turn's wait (see there).
 */
export interface Prompts {
	/**
	 * Asks to approve an action; `signal` cancels the prompt when the turn stops. `minTier` is the
	 * tier the scope's speaker needs to approve it themselves, `owner` when absent; below it the
	 * prompt goes to the owners, or, when the scope escalates to no one, resolves `expired` at once.
	 * `pending` comes only with a `wait`.
	 */
	confirm(
		title: string,
		message: string,
		signal?: AbortSignal,
		minTier?: Tier,
		wait?: PromptWait,
	): Promise<Approval>;
	/**
	 * Asks a question; undefined when no one answered it or it was cancelled, and `pending`, only
	 * with a `wait`, when the turn stopped waiting and the question stays open.
	 */
	ask(
		title: string,
		question: OwnerQuestion,
		signal?: AbortSignal,
		wait?: PromptWait,
	): Promise<OwnerAnswer | "pending" | undefined>;
}

/** @deprecated Since 0.9 the prompts are `Prompts`, answered by those their `PromptScope` names; this name goes away in 1.0. */
export type OwnerPrompts = Prompts;

/**
 * The scope of a turn's prompts: the speaker's own, escalating to the owners unless the
 * conversation is private to one principal.
 */
export function promptScope(
	speaker: Speaker,
	visibility: ConversationVisibility = "shared",
): PromptScope {
	return {
		principalId: speaker.principalId,
		speakerId: speaker.id,
		tier: speaker.tier,
		escalate: visibility === "private" ? "none" : "owners",
	};
}

/**
 * The scope of a turn's prompts, from its speaker and its conversation, shared when the request
 * names none; undefined for a turn without a speaker, whose prompts are the owners'.
 */
export function promptScopeOf(
	request: Pick<TurnRequest, "speaker" | "conversation">,
): PromptScope | undefined {
	return (
		request.speaker &&
		promptScope(request.speaker, request.conversation?.visibility)
	);
}

/** Whether a `prompts` argument is a scope, not the 0.8 speaker that the port still takes. */
export function isPromptScope(
	value: PromptScope | Speaker,
): value is PromptScope {
	return "escalate" in value;
}
