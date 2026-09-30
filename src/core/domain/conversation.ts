import type { InboundMessage } from "../contract/channels.ts";
import type { ChannelKey } from "../sessions.ts";
import type { AgentRunError } from "./errors.ts";
import type { ProfileId } from "./profile.ts";

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
}

export interface PendingConfirmation {
	profile: ProfileId;
	heldAt: Date;
	calls: HeldCall[];
}

export type TurnResult =
	| { ok: true; text: string; thinking?: string }
	| { ok: false; error: AgentRunError; stopped?: true };

export interface OutboundReply {
	/** The assistant's thinking for this turn, posted as a quiet line before the card. */
	thinking?: string;
	/** PNG card, absent when rendering failed or the channel shows none. */
	card?: Uint8Array;
	/** Message texts in posting order; the card is posted before them. */
	chunks: string[];
	/** Files the run produced, posted after the text. */
	files?: { name: string; data: Uint8Array }[];
}
