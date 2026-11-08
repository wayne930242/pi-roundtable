// The parts of a room message that name an author or a card between agents, shared by the server and the page; `api-types.ts` re-exports them.

/** What an agents' message card shows besides its text: which way it went and the other agent. */
export interface RoomIntercom {
	/** `sent`: the author's request; `answered`: the answer that came back; `failed`: none came. */
	kind: "sent" | "answered" | "failed";
	/** The agent the request went to, which also gives the answer. */
	peer: { name: string; displayName: string };
}

/** The kinds of author a host room's messages come from. */
export type HostAuthorKind = "external" | "member" | "assistant" | "notice";

/** A picture the page may draw: a stored file, a person's picture, or initials; never an outside URL. */
export type PictureRef =
	| { file: string }
	| { principal: string }
	| { initials: string; color: string };
