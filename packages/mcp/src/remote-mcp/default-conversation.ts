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

/**
 * The system prompt of the default remote conversations when the dispatch token stands for an
 * owner, unless the host gives its own: 0.8's, word for word.
 */
export const DEFAULT_PERSONA =
	"You are the owner's personal assistant. The owner is writing to you through an outside agent over MCP, not on Discord, and each message begins with a note saying so. Answer the owner directly.";

/**
 * The system prompt of the default remote conversations when the dispatch token stands for someone
 * who is not an owner, unless the host gives its own: it names no owner, so the agent does not
 * take them for one.
 */
export const MEMBER_PERSONA =
	"You are a personal assistant. The person you serve is writing to you through an outside agent over MCP, not on Discord, and each message begins with a note saying so. Answer them directly.";

/**
 * Who the default turns were for in 0.8: the owner, reached through an outside agent that holds
 * the dispatch token.
 * @deprecated The turns are for the principal the dispatch token stands for, as
 * `IDENTITY.speakerFor` gives them; 0.8's `remote-mcp` rows are the primary owner's. Goes away in 1.0.
 */
export const REMOTE_SPEAKER: Speaker = {
	id: "remote-mcp",
	name: "Remote agent",
	tier: "owner",
	principalId: "remote-mcp",
};

/** How the plugin runs a remote turn and a remote conversation's claim operations. */
export interface RemoteConversation {
	/** Runs one turn for `speaker`, the principal the dispatch token stands for; never rejects. */
	answer(
		channel: ChannelKey,
		text: string,
		speaker: Speaker,
	): Promise<TurnResult>;
	claim: RemoteClaimHooks;
}

type Parts = Pick<PluginContext, "queue" | "turns"> & {
	/** The agent server, read once every plugin is set up (`services.lazy(AGENTS)`). */
	server: () => AgentServer;
};

/**
 * Runs remote turns on the core: `context.turns.run` of kind `remote` for the speaker the token
 * stands for, in a conversation private to them, in the channel's queue, with nothing posted since
 * no surface serves `mcp:` channels. A relayed message that approves held actions confirms them,
 * as the person's own reply would on Discord.
 */
export function defaultConversation({
	queue,
	turns,
	server,
}: Parts): RemoteConversation {
	return {
		answer: (channel, text, speaker) =>
			queue.run(channel, () =>
				settleTurn(async () => {
					const { runtime, approvals } = server();
					// Restored from the store: after a restart nothing is held in memory yet.
					const pending = await runtime.heldActions(channel);
					const confirmed =
						pending !== undefined && (await approvals.approves(pending, text));
					return turns.run({
						channel,
						kind: REMOTE_KIND,
						text,
						speaker,
						conversation: { visibility: "private" },
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
