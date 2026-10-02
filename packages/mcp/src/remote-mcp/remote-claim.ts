import type {
	BackgroundTurn,
	ChannelClaim,
	ChannelKey,
	ScheduledOutcome,
} from "pi-roundtable";
import type { RemoteSessionStore } from "./remote-session-store.ts";

/** Outside agents' conversations rank above the owner's catch-all claim; no Discord message reaches them. */
export const REMOTE_PRIORITY = 30;

export const REMOTE_PREFIX = "mcp:";

/**
 * What the claim over `mcp:<session>` channels does with a conversation, besides admitting no
 * message: the operations of a channel claim, each running inside the channel's queue. The
 * default runs them on the core's runtime; a host that runs the conversations itself gives its own.
 */
export interface RemoteClaimHooks {
	/** A background turn in a remote channel, such as a schedule's; absent, they are skipped. */
	background?(turn: BackgroundTurn): Promise<ScheduledOutcome>;
	/** Stops the channel's running turn; true when one was running. */
	stop?(channel: ChannelKey): boolean;
	/** Starts the conversation over, saying whose it was: the string is the conversation kind. */
	startFresh(channel: ChannelKey): Promise<string>;
	/** Removes the conversation for good; the session record is deleted after it. */
	deleteConversation(channel: ChannelKey): Promise<void>;
}

/**
 * The conversations outside agents hold with the owner's agent over remote MCP, `mcp:<session>`:
 * deleting one also ends the outside agent's session.
 */
export function remoteClaim(
	hooks: RemoteClaimHooks,
	sessions: Pick<RemoteSessionStore, "remove">,
): ChannelClaim {
	return {
		name: "remote-mcp",
		priority: REMOTE_PRIORITY,
		owns: (channel) => channel.startsWith(REMOTE_PREFIX),
		admit: () => undefined,
		...(hooks.background ? { background: hooks.background } : {}),
		...(hooks.stop ? { stop: hooks.stop } : {}),
		startFresh: hooks.startFresh,
		deleteConversation: async (channel) => {
			await hooks.deleteConversation(channel);
			await sessions.remove(channel.slice(REMOTE_PREFIX.length));
		},
	};
}
