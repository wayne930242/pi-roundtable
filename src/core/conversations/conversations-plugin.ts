import type { SQL } from "bun";
import type { RoundtablePlugin } from "../plugin.ts";
import { CONVERSATIONS } from "../services.ts";
import type { ConversationRegistry } from "./conversation-registry.ts";
import { PgConversationRegistry } from "./conversation-store.ts";

/** The name of the conversation registry's plugin, as the migration ledger names it. */
export const CONVERSATIONS_PLUGIN = "conversations";

/**
 * The conversation registry, provided as `CONVERSATIONS`: every conversation run through
 * `context.turns`, recorded at its first turn. No session file moves; a conversation from before
 * the registry is recorded at its next turn.
 */
export function conversationsPlugin(
	/** Opens the registry; a test hands a stand-in, so the plugin sets up without a database. */
	open: (sql: SQL) => Promise<ConversationRegistry> = (sql) =>
		PgConversationRegistry.attach(sql),
): RoundtablePlugin {
	return {
		name: CONVERSATIONS_PLUGIN,
		migrations: [PgConversationRegistry.migration],
		provides: [CONVERSATIONS],
		setup: async ({ database, services }) => {
			services.provide(CONVERSATIONS, await open(database()));
			return {};
		},
	};
}
