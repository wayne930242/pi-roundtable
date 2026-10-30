import type { HeldCall } from "../domain/conversation.ts";
import { MEMORY_TOOLS } from "../modules/memory/owner-memory.ts";
import type { Tier } from "../speakers.ts";
import { type ToolTiers, toolsForTier } from "../tool-tiers.ts";

const MEMORY = new Set<string>(MEMORY_TOOLS);

/**
 * The tools a turn is given: its selection, and the tools of the held calls an approving turn
 * releases, limited to the speaker's tier; a speaker kept out of memory gets none of its tools.
 */
export function turnTools(
	turn: {
		selected: readonly string[];
		held: readonly Pick<HeldCall, "tool">[];
		tier: Tier;
		withheld: boolean;
	},
	tiers: ToolTiers,
): string[] {
	return toolsForTier(
		[...new Set([...turn.selected, ...turn.held.map((call) => call.tool)])],
		turn.tier,
		tiers,
	).filter((name) => !turn.withheld || !MEMORY.has(name));
}
