import type {
	AgentServer,
	ChannelKey,
	PluginContext,
	Speaker,
	TurnResult,
} from "pi-roundtable";
import { settleTurn } from "pi-roundtable/kit";
import type { RemoteClaimHooks } from "./remote-claim.ts";

/** The conversation kind of the default remote conversations, and of their persona. */
export const REMOTE_KIND = "remote";

/** The system prompt of the default remote conversations, unless the host gives its own. */
export const DEFAULT_PERSONA =
	"You are the owner's personal assistant. The owner is writing to you through an outside agent over MCP, not on Discord, and each message begins with a note saying so. Answer the owner directly.";

/** Who the default turns are for: the owner, reached through an outside agent that holds the dispatch token. */
export const REMOTE_SPEAKER: Speaker = {
	id: "remote-mcp",
	name: "Remote agent",
	tier: "owner",
	// The principal 0.8 keyed this speaker's rows by; the token is bound to a principal later.
	principalId: "remote-mcp",
};

/** How the plugin runs a remote turn and a remote conversation's claim operations. */
export interface RemoteConversation {
	answer(channel: ChannelKey, text: string): Promise<TurnResult>;
	claim: RemoteClaimHooks;
}

type Parts = Pick<PluginContext, "queue" | "turns"> & {
	/** The agent server, read once every plugin is set up (`services.lazy(AGENTS)`). */
	server: () => AgentServer;
};

/**
 * Runs remote turns on the core: `context.turns.run` of kind `remote` for an owner-tier speaker,
 * in the channel's queue, with nothing posted since no surface serves `mcp:` channels. A relayed
 * message that approves held actions confirms them, as the owner's reply would on Discord.
 */
export function defaultConversation({
	queue,
	turns,
	server,
}: Parts): RemoteConversation {
	return {
		answer: (channel, text) =>
			queue.run(channel, () =>
				settleTurn(async () => {
					const { runtime, approvals } = server();
					const pending = runtime.pendingConfirmation(channel);
					const confirmed =
						pending !== undefined && (await approvals.approves(pending, text));
					return turns.run({
						channel,
						kind: REMOTE_KIND,
						text,
						speaker: REMOTE_SPEAKER,
						confirmed,
						// The outside agent polls for the answer; no surface posts it.
						reply: async () => undefined,
					});
				}, "remote turn"),
			),
		claim: {
			stop: (channel) => server().runtime.stop(channel),
			startFresh: async (channel) => {
				await server().runtime.startFresh(channel);
				return REMOTE_KIND;
			},
			deleteConversation: (channel) =>
				server().runtime.deleteConversation(channel),
		},
	};
}
