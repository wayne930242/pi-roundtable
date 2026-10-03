import { PluginError } from "./errors.ts";
import { type Tier, tierAtLeast } from "./speakers.ts";

/** What a hold rule knows about the session making the call. */
export interface HoldContext {
	/** The shared workspace of a session with a shell; calls reaching outside it may be held. */
	workspace?: string;
}

/**
 * Decides whether a tool call waits for the owner's approval. A rule answers with a short
 * description of what the call would do, or undefined when it has no opinion on the call.
 */
export interface HoldRule {
	name: string;
	describe(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): string | undefined;
	/**
	 * Whether this rule may hold some call of `tool`, for a rule whose verdict depends on the input
	 * (such as an action argument). Asked when the input is not known yet, as for a precheck
	 * script's call whose arguments are computed when it runs; a rule without it is judged by
	 * `describe` with an empty input.
	 */
	mayHold?(tool: string): boolean;
	/**
	 * The lowest tier that may approve a call this rule holds, when it is higher than the tool's own:
	 * for a call that stands for others, such as saving a script whose runs make held calls.
	 */
	approvalTier?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): Tier | undefined;
}

/** The description of a call that must be approved first, or undefined to let it run. */
export type HoldCheck = ((
	tool: string,
	input: Record<string, unknown>,
	context: HoldContext,
) => string | undefined) & {
	/** The name of a rule that may hold some call of `tool` whatever its input; see `HoldRule.mayHold`. */
	mayHold?(tool: string): string | undefined;
	/** The highest tier any rule requires to approve the call; see `HoldRule.approvalTier`. */
	approvalTier?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): Tier | undefined;
};

/** The higher of two tiers; undefined only when both are. */
export function higherTier(
	a: Tier | undefined,
	b: Tier | undefined,
): Tier | undefined {
	if (!a) return b;
	if (!b) return a;
	return tierAtLeast(a, b) ? a : b;
}

/** Asks the rules in order; the first description holds the call. */
export function holdChain(rules: readonly HoldRule[]): HoldCheck {
	const names = new Set<string>();
	for (const rule of rules) {
		if (names.has(rule.name))
			throw new PluginError(
				`hold rule ${rule.name} is registered twice. Rename one of the two.`,
			);
		names.add(rule.name);
	}
	const check: HoldCheck = (tool, input, context) => {
		for (const rule of rules) {
			const description = rule.describe(tool, input, context);
			if (description !== undefined) return description;
		}
		return undefined;
	};
	check.mayHold = (tool) => rules.find((rule) => rule.mayHold?.(tool))?.name;
	check.approvalTier = (tool, input, context) =>
		rules.reduce<Tier | undefined>(
			(tier, rule) =>
				higherTier(tier, rule.approvalTier?.(tool, input, context)),
			undefined,
		);
	return check;
}
