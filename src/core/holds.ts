import type { ToolTurn } from "./define.ts";
import { PluginError } from "./errors.ts";
import { type Tier, tierAtLeast } from "./speakers.ts";

/**
 * How long the confirmation gate waits for a hold that looks things up before it describes the
 * call generically and holds it anyway, in milliseconds.
 */
export const HOLD_DESCRIBE_TIMEOUT_MS = 10_000;

/** What a hold rule knows about the session making the call. */
export interface HoldContext {
	/** The shared workspace of a session with a shell; calls reaching outside it may be held. */
	workspace?: string;
	/** The session's scratch dir, where its shell's TMPDIR points; writes and removals inside it run. */
	scratchDir?: string;
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
	 * `describe` for a rule that must look something up as the turn's speaker before it can describe
	 * the call, which it may answer later. The confirmation gate asks it, instead of `describe`,
	 * when a turn makes the call, and waits for the answer up to `HOLD_DESCRIBE_TIMEOUT_MS`; a
	 * rejection or a timeout holds the call under a generic description. `turn.signal` aborts when the
	 * turn stops or the wait ends. `describe` stays what a host without a turn sees, such as a
	 * precheck script's call, and answers at once.
	 */
	describeInTurn?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
	): string | undefined | Promise<string | undefined>;
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
	/**
	 * The check as a turn runs it: each rule's `describeInTurn`, or its `describe` for a rule
	 * without one, asked in order until one describes the call. It answers at once when every rule
	 * asked did, and otherwise as a promise that rejects when a rule's does.
	 */
	inTurn?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
	): string | undefined | Promise<string | undefined>;
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
	check.inTurn = (tool, input, context, turn) => {
		const ask = (
			from: number,
		): string | undefined | Promise<string | undefined> => {
			for (let at = from; at < rules.length; at++) {
				const rule = rules[at];
				if (!rule) continue;
				const description = rule.describeInTurn
					? rule.describeInTurn(tool, input, context, turn)
					: rule.describe(tool, input, context);
				if (isPromise(description))
					return description.then((found) =>
						found !== undefined ? found : ask(at + 1),
					);
				if (description !== undefined) return description;
			}
			return undefined;
		};
		return ask(0);
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

/** Whether a hold's answer comes later. */
export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}
