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
}

export interface PendingConfirmation {
	/** The id of the TurnSelection whose turn held the calls; the caller resolves it on replay. */
	selectionId: string;
	heldAt: Date;
	calls: HeldCall[];
}

/** A file produced for a reply; data is raw bytes, not a path or base64. */
export interface ReplyFile {
	name: string;
	data: Uint8Array;
}

export type TurnResult =
	| { ok: true; text: string; thinking?: string; files?: ReplyFile[] }
	| { ok: false; error: Error; stopped?: true };

export interface OutboundReply {
	/** The assistant's thinking for this turn, posted as a quiet line before the card. */
	thinking?: string;
	/** PNG card, absent when rendering failed or the channel shows none. */
	card?: Uint8Array;
	/** Message texts in posting order; the card is posted before them. */
	chunks: string[];
	/** Files the run produced, posted after the text. */
	files?: ReplyFile[];
}
