import type { ConversationRecord } from "../conversations/conversation-registry.ts";
import { guarded, integer, optional, record, shape } from "./schema.ts";

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
	/**
	 * Asked for each conversation the sweep would delete, after its kind's `keepDays` ran out:
	 * answer `true` to keep it for now, such as a support conversation whose ticket is still open.
	 * It is asked again at the next sweep, so a conversation kept today is deleted once the host
	 * stops wanting it. A function that throws or rejects keeps the conversation for this sweep and
	 * is logged. Without it
	 * every conversation past its days is deleted.
	 */
	keep?: (conversation: ConversationRecord) => boolean | Promise<boolean>;
}

/** The longest keep the configuration accepts, in days: a hundred years. */
const MAX_DAYS = 36_500;

/** The `conversations` key's shape. */
export const conversationsShape = optional(
	shape({
		keepDays: optional(record(integer(1, MAX_DAYS))),
		keep: optional(
			guarded(
				"a function from a conversation record to true to keep it",
				(value): value is NonNullable<ConversationsConfig["keep"]> =>
					typeof value === "function",
			),
		),
	}),
);
