import { PluginError } from "./errors.ts";
import { ASK_USER_TOOL } from "./runtime/extensions/ask-user.ts";
import { COMPACT_TOOL } from "./runtime/extensions/self-compact-guard.ts";
import { type Tier, tierAtLeast } from "./speakers.ts";

/** The lowest tier that may use each tool; a tool that is not named needs the owner. */
export interface ToolTiers {
	minTier(tool: string): Tier;
	/** Whether a speaker of `tier` may use the tool. */
	allows(tier: Tier, tool: string): boolean;
}

const set = (tier: Tier, tools: readonly string[]) =>
	Object.fromEntries(tools.map((tool) => [tool, tier]));

/**
 * The core's own tools, which serve any turn that can ask, compact, or read an attachment.
 * Every other feature declares the tiers of its tools with its plugin (`Contribution.toolTiers`):
 * members talk, read, look things up, and message agents; admins also create and edit agents,
 * groups, skills, schedules, and delegated work; everything else, such as the shell, the owner's
 * notes, Discord administration, and any plugin's tools, stays with the owner until an operator
 * lowers it.
 */
export const CORE_TOOL_TIERS: Readonly<Record<string, Tier>> = set("member", [
	ASK_USER_TOOL,
	COMPACT_TOOL,
	"read_attachment",
]);

/**
 * Tools renamed since 0.8, by their old name: until 1.0 the old name still names the tool in a
 * selection and in the operator's `toolTiers`, where the new name's own setting wins.
 */
export const RENAMED_TOOLS: Readonly<Record<string, string>> = {
	notify_owner: "notify",
};

/** The tools named, each by its current name and once, in order. */
export function currentToolNames(tools: readonly string[]): string[] {
	return [...new Set(tools.map((tool) => RENAMED_TOOLS[tool] ?? tool))];
}

/**
 * What each tool needs: the operator's setting first, then the tier its plugin declared, then
 * the core's default, and the owner for a tool nobody named. Plugins declare theirs when the
 * host links them, so a reader asks at use time and sees the final table.
 */
export class ToolTierTable implements ToolTiers {
	readonly #operator: ReadonlyMap<string, Tier>;
	readonly #declared = new Map<string, { plugin: string; tier: Tier }>();
	readonly #core = new Map(Object.entries(CORE_TOOL_TIERS));

	constructor(operator: Readonly<Record<string, Tier>> = {}) {
		const entries = Object.entries(operator);
		// An old name first, so the new name's own setting overrides it.
		this.#operator = new Map([
			...entries.flatMap(([tool, tier]) => {
				const renamed = RENAMED_TOOLS[tool];
				return renamed ? [[renamed, tier] as const] : [];
			}),
			...entries,
		]);
	}

	/**
	 * Records the tiers a plugin's tools need; a tool two plugins declare is a PluginError. A
	 * plugin declaring its own tool again, as when the host retries its start, replaces it.
	 */
	declare(plugin: string, tiers: Readonly<Record<string, Tier>>): void {
		for (const [tool, tier] of Object.entries(tiers)) {
			const other = this.#declared.get(tool);
			if (other && other.plugin !== plugin)
				throw new PluginError(
					`plugin ${plugin}: tool ${tool} is already defined by plugin ${other.plugin}. Rename one of the two tools.`,
				);
			this.#declared.set(tool, { plugin, tier });
		}
	}

	minTier(tool: string): Tier {
		return (
			this.#operator.get(tool) ??
			this.#declared.get(tool)?.tier ??
			this.#core.get(tool) ??
			"owner"
		);
	}

	allows(tier: Tier, tool: string): boolean {
		return tierAtLeast(tier, this.minTier(tool));
	}
}

/** The core's tiers with the operator's on top; plugins add theirs through `declare`. */
export function toolTiers(
	operator: Readonly<Record<string, Tier>> = {},
): ToolTierTable {
	return new ToolTierTable(operator);
}

/** The tools a tier may use, in order; a turn's tier is its speaker's, and a turn without one is refused. */
export function toolsForTier(
	tools: readonly string[],
	tier: Tier,
	tiers: ToolTiers,
): string[] {
	return tools.filter((tool) => tiers.allows(tier, tool));
}
