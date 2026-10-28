import type { RoundtablePlugin } from "../plugin.ts";
import { MODES } from "../services.ts";
import { PgConversationModes } from "./conversation-modes.ts";

/** The name of the modes' plugin, as the migration ledger names it. */
export const MODES_PLUGIN = "modes";

/**
 * The per-conversation modes (yolo and long-running), provided as `MODES`. They live in their own
 * table, so they survive a restart: the service loads them when the host starts, before it
 * serves a turn, and until then every conversation reads as both modes off.
 */
export function modesPlugin(): RoundtablePlugin {
	return {
		name: MODES_PLUGIN,
		migrations: [PgConversationModes.migration],
		provides: [MODES],
		setup: ({ database, logger, services }) => {
			const modes = PgConversationModes.attach(database(), logger);
			services.provide(MODES, modes);
			return { services: [{ name: "modes", start: () => modes.load() }] };
		},
	};
}
