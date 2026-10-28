import type { InboundMessage } from "../contract/channels.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Tier } from "../speakers.ts";

export { QUEUED_MARK, STEERED_MARK } from "../contract/channels.ts";
export type { ChannelKey, InboundMessage };

export interface TranscriptEntry {
	role: "user" | "assistant";
	text: string;
}

/** One tool call held for the owner's confirmation, exactly as the model made it. */
export interface HeldCall {
	tool: string;
	/** The call's input as canonical JSON; only an identical call is released. */
	input: string;
	/** What the call would do, in plain words. */
	action: string;
	/** The lowest tier that may approve it, when higher than its tool's own; see `HoldRule.approvalTier`. */
	minTier?: Tier;
	/**
	 * The principal ids that may approve it instead of the speaker whose turn held it, as the tool's
	 * `approvers` named them; the owners may still. Absent when the tool names none, and an empty
	 * list leaves the owners alone. They are kept with the call, so a message that confirms it after
	 * a restart honors them; a private conversation ignores them.
	 */
	approverIds?: string[];
	/**
	 * The hold classes of the rules that held it, as `<rule>.<class>` ids (see `HoldRule.holdClasses`),
	 * kept with the call across a restart. Absent for a call held before 0.23 or by a check that
	 * has no classes: its classes are unknown, and yolo mode always asks a card for it.
	 */
	holdClasses?: string[];
}

export interface PendingConfirmation {
	/** The id of the TurnSelection whose turn held the calls; the caller resolves it on replay. */
	selectionId: string;
	heldAt: Date;
	calls: HeldCall[];
	/**
	 * The speaker whose turn held the calls, by their id on the surface. Besides the owners, only
	 * they may approve them, at a tier that holds them; without one, the owners alone may.
	 */
	speakerId?: string;
	/**
	 * The principal of that speaker, who approves them on any of their identities; absent for
	 * calls held before 0.9, which are matched by `speakerId`.
	 */
	principalId?: string;
}

/** A file produced for a reply; data is raw bytes, not a path or base64. */
export interface ReplyFile {
	name: string;
	data: Uint8Array;
}

export type TurnResult =
	| { ok: true; text: string; thinking?: string; files?: ReplyFile[] }
	| { ok: false; error: Error; stopped?: true };

/**
 * Who a reply speaks as on a surface that shows authors, such as an agent in a room: the name to
 * show and, for an agent of the agent team, its stable name.
 */
export interface PostAuthor {
	/** The name to show, such as an agent's display name. */
	name: string;
	/** The agent's name, when an agent of the agent team speaks. */
	agent?: string;
}

export interface OutboundReply {
	/** The assistant's thinking for this turn, posted as a quiet line before the card. */
	thinking?: string;
	/** PNG card, absent when rendering failed or the channel shows none. */
	card?: Uint8Array;
	/** Message texts in posting order; the card is posted before them. */
	chunks: string[];
	/** Files the run produced, posted after the text. */
	files?: ReplyFile[];
	/**
	 * Who speaks, for a surface that shows authors, such as a room of an agent. Absent = the
	 * assistant. Discord posts agents through webhooks and ignores it.
	 */
	author?: PostAuthor;
}
