import type { AgentTurnScope, TurnSelection } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { TurnAttachments } from "./attachment.ts";
import type { ChannelKey } from "./conversation.ts";
import type { InterimPosts } from "./interim.ts";
import type { TurnProgress } from "./progress.ts";

export type { AgentTurnScope };

/** Who a turn's conversation belongs to. */
export type TurnConversation =
	| { visibility: "private"; principalId: string }
	| { visibility: "shared" };

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
	/**
	 * The person the turn is for: who wrote the message, or who set up the work; the turn runs at
	 * their tier. Required: a turn without one is refused, never run as the owner's. A plugin that
	 * starts a turn on someone's behalf gets theirs from `IDENTITY.speakerFor`.
	 */
	speaker: Speaker;
	/**
	 * Who the conversation belongs to, as the host records it: `private` to one principal, or
	 * `shared` by whoever its claim admits, which it is taken to be when absent. A private
	 * conversation's prompts are its person's alone; a shared one's escalate to the owners.
	 */
	conversation?: TurnConversation;
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
	/**
	 * Where the turn posts the text it writes before its final answer, as it goes; the caller
	 * hands the channel its reply goes to. Absent = only the final reply is posted.
	 */
	interim?: InterimPosts;
	/**
	 * Hears what the turn writes and which tools it runs, as it goes, until the turn ends. A runtime
	 * without live progress never calls it.
	 */
	progress?: (event: TurnProgress) => void;
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
