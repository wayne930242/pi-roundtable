import { remoteMcp } from "pi-roundtable-mcp";

/**
 * A host that runs the owner's conversations itself passes `answer` and `claim` together. `answer`
 * runs one turn and never rejects; it joins the channel's queue itself. `claim` says what the
 * claim over the `mcp:<session>` channels does with those conversations.
 */
export function hostRemote(dispatchToken: string, publicUrl: string) {
	return remoteMcp({
		dispatchToken,
		publicUrl,
		// `speaker` is the principal the dispatch token stands for.
		answer: async (channel, text, speaker) => ({
			ok: true,
			text: `Answered ${speaker.name}'s ${text.length} characters in ${channel}.`,
		}),
		claim: {
			// The string names whose conversation it was: the host's own kind.
			startFresh: async () => "owner",
			deleteConversation: async () => undefined,
		},
	});
}
