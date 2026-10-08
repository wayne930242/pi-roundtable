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
 * visibility, and principal are fixed then; each later turn only marks it active. Who may speak
 * in it stays the claim's decision: the registry records, it does not refuse.
 */
export interface ConversationRegistry {
	/** Records the conversation at its first turn, or marks a known one active; returns what is stored. */
	register(entry: ConversationRegistration): Promise<ConversationRecord>;
	get(key: ChannelKey): Promise<ConversationRecord | undefined>;
	/** One principal's conversations, or every one; the most recently active first. */
	list(filter?: { principal?: string }): Promise<ConversationRecord[]>;
	/**
	 * Only for migrating a conversation recorded before 0.9, when every turn run without a
	 * visibility was recorded `shared` with no principal: makes such a conversation private to
	 * `principalId`, as the plugin that hands over what 0.8 left behind decides, such as remote-mcp
	 * giving 0.8's sessions to the primary owner. A conversation that is private or names a
	 * principal never changes, so adopting is safe to repeat and to race: one principal wins.
	 * Returns what is stored, or undefined when the key is unknown.
	 */
	adopt(
		key: ChannelKey,
		principalId: string,
	): Promise<ConversationRecord | undefined>;
	/** Names a conversation, or clears its name; undefined when the key is unknown. */
	setTitle(
		key: ChannelKey,
		title: string | undefined,
	): Promise<ConversationRecord | undefined>;
}
