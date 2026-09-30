/** Whose conversation a channel holds, as starting it over reports it. */
export type ConversationKind = "owner" | "party" | "agent";

const isKind = (kind: string): kind is ConversationKind =>
	kind === "owner" || kind === "party" || kind === "agent";

/** Narrows what a claim's startFresh said; a claim the host does not know about is a bug. */
export async function conversationKind(
	whose: Promise<string>,
): Promise<ConversationKind> {
	const kind = await whose;
	if (!isKind(kind)) throw new Error(`unknown conversation kind "${kind}"`);
	return kind;
}
