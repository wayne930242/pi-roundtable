import type { ChannelKey } from "../sessions.ts";

/** Who may take part: `private` belongs to one principal, `shared` to whoever its claim admits. */
export type ConversationVisibility = "private" | "shared";

/** What the first turn of a conversation records about it. */
export interface ConversationRegistration {
	key: ChannelKey;
	/** The conversation's kind, such as "study"; the persona its session runs. */
	kind: string;
	visibility: ConversationVisibility;
	/** Whose conversation it is: the speaker's id, for a private one. */
	principalId?: string;
	/** A name to list it by. */
	title?: string;
}

/** A conversation the host knows: who it belongs to and when it was last active. */
export interface ConversationRecord extends ConversationRegistration {
	/** The prefix of its key, such as "web". */
	surface: string;
	createdAt: Date;
	lastActiveAt: Date;
}

/**
 * The conversations run through `context.turns`, recorded at their first turn. Its kind,
 * visibility, and principal are fixed then; each later turn only marks it active, except that one
 * recorded `shared` with no principal, as 0.8 recorded every turn run without a visibility,
 * becomes private to the first registration that asks for `private` with a principal. One with a
 * principal never changes hands. Who may speak in it stays the claim's decision: the registry
 * records, it does not refuse.
 */
export interface ConversationRegistry {
	/**
	 * Records the conversation at its first turn, or marks a known one active, making a shared one
	 * of no principal private when asked; returns what is stored.
	 */
	register(entry: ConversationRegistration): Promise<ConversationRecord>;
	get(key: ChannelKey): Promise<ConversationRecord | undefined>;
	/** One principal's conversations, or every one; the most recently active first. */
	list(filter?: { principal?: string }): Promise<ConversationRecord[]>;
	/** Names a conversation, or clears its name; undefined when the key is unknown. */
	setTitle(
		key: ChannelKey,
		title: string | undefined,
	): Promise<ConversationRecord | undefined>;
}
