import type { AgentTurnScope, TurnSelection } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { TurnAttachments } from "./attachment.ts";
import type {
	ChannelKey,
	InboundMessage,
	OutboundReply,
	PendingConfirmation,
	TranscriptEntry,
	TurnResult,
} from "./conversation.ts";

export interface ChatSurface {
	start(onMessage: (message: InboundMessage) => void): Promise<void>;
	sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void>;
	/** Shows the typing indicator until the returned function is called. */
	startTyping(channel: ChannelKey): () => void;
	/**
	 * Shows the owner a stop button once the turn has run a few seconds, until the returned
	 * function is called.
	 */
	showStop(channel: ChannelKey): () => void;
	/** Adds or removes the bot's reaction on a message; failures are logged, never thrown. */
	react(channel: ChannelKey, messageId: string, emoji: string): Promise<void>;
	unreact(channel: ChannelKey, messageId: string, emoji: string): Promise<void>;
}

export type { AgentTurnScope };

export interface TurnRequest {
	/** Where the turn's message arrived and its attachments are saved. */
	channel: ChannelKey;
	/** The turn's tools; the owner's conversations pick a profile's, an agent's are the agent union. */
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
	/** The owner's own chat turn, which his next messages may steer. */
	steerable?: boolean;
	/**
	 * The owner started the turn by writing in its channel, or it delivers a dispatch's report,
	 * so it may ask him there on cards: approvals of held actions and ask_user questions. A
	 * schedule's turn is not.
	 */
	interactive?: boolean;
}

export interface AgentRuntime {
	runTurn(request: TurnRequest): Promise<TurnResult>;
	/** Held actions of a conversation: a channel, or an agent's session key. */
	pendingConfirmation(channel: ChannelKey): PendingConfirmation | undefined;
	recentTranscript(
		channel: ChannelKey,
		limit: number,
	): Promise<TranscriptEntry[]>;
	/** Archives a conversation (a channel, or an agent's session key) and drops its held actions; call between turns. */
	startFresh(channel: ChannelKey): Promise<void>;
	/** Like `startFresh`, but removes the conversation and every archive of it for good; call between turns. */
	deleteConversation(channel: ChannelKey): Promise<void>;
	/**
	 * Adds the message to the conversation's running turn when that turn is steerable and holds
	 * no actions; false when the message must wait for its own turn.
	 */
	steer(
		channel: ChannelKey,
		text: string,
		attachments: TurnAttachments,
		/** The message's author; a turn another speaker started takes no steering from them. */
		speakerId?: string,
	): Promise<boolean>;
	/** Aborts the conversation's running turn and drops what was steered into it; false when none runs. */
	stop(channel: ChannelKey): boolean;
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
