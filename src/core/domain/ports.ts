import type { AgentTurnScope, TurnSelection } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { TurnAttachments } from "./attachment.ts";
import type { ClientPort } from "./client.ts";
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
	/**
	 * The speaker confirmed the channel's pending actions, so they may run in this turn, except
	 * those that named approvers the speaker is neither among nor an owner of, which stay pending.
	 */
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
	 * Where the request came from, as the transport that carried it knows: the browser origin of a
	 * web chat connection, such as `https://chat.example.com`. A channel with no such thing leaves it
	 * out. Only a channel's transport sets it, never the message text or the model; a tool reads it
	 * as `ToolTurn.origin`.
	 */
	origin?: string;
	/**
	 * What the client that started the turn can do for its tools, such as run a function in a
	 * browser; a tool reads it as `ToolTurn.client`. A channel whose transport has no such client
	 * leaves it out. Only a channel's transport provides one, never the message text or the model.
	 */
	client?: ClientPort;
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
	 * A person's message started the turn, so the speaker is present: only such a turn spends a late
	 * approval's release. Set by message ingest alone, never by a schedule, agent message, report or error turn.
	 */
	byMessage?: boolean;
	/**
	 * The owner started the turn by writing in its channel, or it delivers a dispatch's report,
	 * so it may ask them there on cards: approvals of held actions and ask_user questions. A
	 * schedule's turn is not.
	 */
	interactive?: boolean;
	/**
	 * No person waits on the turn's answer: a schedule's turn, an agent's message, an agent's
	 * opening task. A turn like that may end with nothing to say, which is an empty answer
	 * instead of a failure; the reply is then not posted. Absent = someone waits, and an empty
	 * final answer fails.
	 */
	unattended?: boolean;
	/**
	 * How long the turn may work, in ms, in place of the runtime's default time limit; a schedule's
	 * own limit. The runtime never lets it pass the long-running cap. Absent = the default.
	 */
	timeLimitMs?: number;
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

/** Sends a person a notice through their own channel; resolves false when they have none. */
export interface Notifier {
	notify(principalId: string, text: string): Promise<boolean>;
}

/**
 * Sends the primary owner a direct message.
 * @deprecated Since 0.9 there may be more than one owner: reach a person with a `Notifier`, such as
 * `context.directChannels`. Goes away in 1.0.
 */
export interface OwnerNotifier {
	notifyOwner(text: string): Promise<void>;
}
