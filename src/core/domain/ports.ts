import type { AgentTurnScope, TurnSelection } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { TurnAttachments } from "./attachment.ts";
import type { ChannelKey } from "./conversation.ts";

export type { AgentTurnScope };

export interface TurnRequest {
	/** Where the turn's message arrived and its attachments are saved. */
	channel: ChannelKey;
	/** The caller's choice of tools for the turn, such as an agent's union. */
	selection: TurnSelection;
	text: string;
	/** Files and images the message carries; none when absent. */
	attachments?: TurnAttachments;
	/** The owner confirmed the channel's pending actions, so they may run in this turn. */
	confirmed?: boolean;
	/** Set for a turn of an agent-server agent. */
	agent?: AgentTurnScope;
	/** The person the turn is for: who wrote the message, or who set up the work. */
	speaker?: Speaker;
	/**
	 * The conversation's kind, fixed when its session is made: the string a claim's `startFresh`
	 * returns, which picks the persona of a non-agent conversation. "owner" when absent.
	 */
	kind?: string;
	/** The owner's own chat turn, which their next messages may steer. */
	steerable?: boolean;
	/**
	 * The owner started the turn by writing in its channel, or it delivers a dispatch's report,
	 * so it may ask them there on cards: approvals of held actions and ask_user questions. A
	 * schedule's turn is not.
	 */
	interactive?: boolean;
}

/** The judge's question and answer shapes. */
export type {
	ChoiceAnswer,
	ChoiceQuestion,
	ScoreQuestion,
	YesNoQuestion,
} from "../contract/providers.ts";

export interface OwnerNotifier {
	notifyOwner(text: string): Promise<void>;
}
