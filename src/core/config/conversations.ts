import { integer, optional, record, shape } from "./schema.ts";

/** The configuration's `conversations`: what the host does with the conversations it has recorded. */
export interface ConversationsConfig {
	/**
	 * How many days a recorded conversation of each kind (`ConversationRecord.kind`, such as
	 * "support") is kept after it was last active; a daily sweep then deletes it, as
	 * `ConversationPort.deleteConversation` does, and forgets its record. A conversation with a turn
	 * running or waiting is skipped and tried again the next day. A kind left out is kept for ever,
	 * which is what a host without this key does.
	 */
	keepDays?: Readonly<Record<string, number>>;
}

/** The longest keep the configuration accepts, in days: a hundred years. */
const MAX_DAYS = 36_500;

/** The `conversations` key's shape. */
export const conversationsShape = optional(
	shape({ keepDays: optional(record(integer(1, MAX_DAYS))) }),
);
