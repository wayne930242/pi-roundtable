import type { ConversationVisibility } from "../conversations/conversation-registry.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { Speaker, Tier } from "../speakers.ts";

/**
 * How a prompt ended: answered yes or no; `expired` when the card was shown and no one answered
 * it in time; `unavailable` when no card could be shown (no one may approve the call, the speaker
 * is below its tier, or the card could not be posted); `cancelled` when its turn stopped; or
 * `pending` when the turn stopped waiting while the card stays open, its answer to come through
 * `PromptWait`. A surface that cannot tell the two may answer `expired` for both.
 */
export type Approval =
	| "approved"
	| "declined"
	| "expired"
	| "unavailable"
	| "cancelled"
	| "pending";

/** A file a held call sends by path; `bytes` is its size when it was read, absent when it could not be. */
export interface ApprovalFile {
	path: string;
	bytes?: number;
}

/**
 * What an approval is for, as data: the same facts a card's text shows, so a surface that is not
 * text (a web client) need not read them back out of the markdown. `input` is the call's whole
 * input, never cut.
 */
export interface ApprovalDetails {
	/** What the call would do, in plain words. */
	action: string;
	tool: string;
	input: Record<string, unknown>;
	/** The files the call sends by path; absent when it sends none. */
	files?: ApprovalFile[];
}

/**
 * Who approved a held call: the principal, the identity they answered with as `Speaker.id`, and
 * the name that identity goes by. A surface reports it when it knows it; a held call's `run`
 * reads it as `ToolTurn.approvedBy`.
 */
export interface ApprovedBy {
	principalId: string;
	speakerId: string;
	name: string;
}

/**
 * What a held call's approval is asked with besides its text: who may approve it, and where to
 * hear who did.
 */
export interface ApprovalOptions {
	/**
	 * The principal ids that may approve this call instead of the scope's speaker. Given in a
	 * conversation that escalates to the owners, the speaker may not approve it unless named, and
	 * each named principal needs the call's tier when they answer; the owners may still approve it.
	 * An empty list leaves the owners alone. A private conversation ignores it: its person is the
	 * only one who answers.
	 */
	approvers?: readonly string[];
	/**
	 * Called with who approved the call, before the approval resolves `approved`; not called for a
	 * refusal, or by a surface that does not know who answered.
	 */
	approvedBy?(by: ApprovedBy): void;
}

/**
 * An answer given on a prompt after its turn stopped waiting; `by` names who gave it. An approval
 * names the approver too, where the surface knows them.
 */
export type LateAnswer = { by: string } & (
	| { kind: "approval"; approved: boolean; approvedBy?: ApprovedBy }
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
	 * an approval comes back `unavailable` at once.
	 */
	escalate: "owners" | "none";
	/**
	 * The principal ids that may approve the call being asked instead of the speaker, as
	 * `ApprovalOptions.approvers` gave them; a surface that serves one call at a time reads them
	 * here. Absent when the call names none, and ignored where `escalate` is `none`.
	 */
	approvers?: readonly string[];
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
	 * `pending` comes only with a `wait`. `details` is the approval as data beside `message`, its
	 * text; a surface that shows text only ignores it. `options` says who else may approve it and
	 * hears who did; see `ApprovalOptions`.
	 */
	confirm(
		title: string,
		message: string,
		signal?: AbortSignal,
		minTier?: Tier,
		wait?: PromptWait,
		details?: ApprovalDetails,
		options?: ApprovalOptions,
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
