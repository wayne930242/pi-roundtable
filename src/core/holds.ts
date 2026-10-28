import type { ToolTurn } from "./define.ts";
import { PluginError } from "./errors.ts";
import type { ApprovalDetails } from "./interactions/prompts.ts";
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
 * What a hold that runs in a turn answers with: the description of the call, or the description
 * as `text` with a `copy` the owner's approval card offers beside it (see `ApprovalDetails.copy`),
 * a `supersede` signal to withdraw the call by, and `approval: "speaker"` to make the card the
 * speaker's alone.
 *
 * With `approval: "speaker"` only the speaker whose turn made the call may answer its card, on
 * any of their identities the surface knows and at the call's tier; no owner may answer it as an
 * owner (an owner who is the speaker answers as the speaker). A speaker below the call's tier, a
 * turn with no speaker, or a surface that cannot tell who the speaker is gets `unavailable` at
 * once and the call stays held. Combined with approvers the card is still the speaker's alone,
 * and the runtime accepts their press only when the approvers name them or they are an owner;
 * otherwise the call stays held. It governs the card only: a message that confirms the held call
 * is judged as for any call, so a tool that must act on the speaker's press alone checks
 * `ToolTurn.approvedPrompt` and `ToolTurn.approvedBy` in `run`. Anything but `"speaker"` leaves
 * the card as every card is.
 *
 * Aborting `supersede` withdraws the call the hold held, when the plugin no longer wants it
 * (a newer request replaced it, its subject is gone): its approval card is closed, also after
 * the turn stopped waiting on it, with the abort reason as its footer when that is a text
 * (`controller.abort("replaced by a newer request")`); the held call is forgotten, so a later
 * approval, on the card or by message, runs nothing; a turn still waiting on the card is told
 * the call was withdrawn. An approval that was answered before the abort stands: the call runs
 * once, or has run. Aborting again, or after the call ran or was answered, does nothing. A
 * signal that is already aborted when the hold answers refuses the call without a card, and
 * drops a confirmation of it, which is how a hold withdraws what a restart left held: the
 * signals do not survive a restart, but a repeated call is described again.
 *
 * `classes` are the hold classes of the call, for a rule that describes it in a turn (see
 * `HoldRule.holdClasses`); a rule that leaves them out has its call classed by its name.
 */
export type HoldDescription =
	| string
	| {
			text: string;
			copy?: NonNullable<ApprovalDetails["copy"]>;
			supersede?: AbortSignal;
			approval?: "speaker";
			classes?: readonly string[];
	  };

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
	 * The classes of a call this rule holds, as `<rule>.<class>` ids such as `shell.rm`, for yolo
	 * mode to tell a call it may approve from one it never does (see `autonomy.yolo`). List every
	 * reason the call is held, not only the first: yolo approves only a call whose classes it all
	 * allows. Asked for a call `describe` held; undefined or an empty list classes the call by the
	 * rule's name. It must change nothing.
	 */
	holdClasses?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): readonly string[] | undefined;
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
	 * precheck script's call, and answers at once. It may answer `{ text, copy }` instead of the
	 * text alone, for the approval card to offer `copy`; a host that shows no card uses `text`.
	 */
	describeInTurn?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
	): HoldDescription | undefined | Promise<HoldDescription | undefined>;
	/**
	 * The lowest tier that may approve a call this rule holds, when it is higher than the tool's own:
	 * for a call that stands for others, such as saving a script whose runs make held calls.
	 */
	approvalTier?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): Tier | undefined;
	/**
	 * The principal ids that may approve a call of this rule's tool instead of the speaker whose turn
	 * makes it, looked up as that turn; undefined when the rule names none and the speaker approves
	 * it, as for any held call. The confirmation gate asks it, with the same wait and `turn.signal`
	 * as `describeInTurn`, for each call it holds; a rejection or a timeout leaves the owners alone
	 * to approve it. Where several rules name approvers for one call, only principals every rule
	 * names may approve. It must change nothing.
	 */
	approversInTurn?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
	): readonly string[] | undefined | Promise<readonly string[] | undefined>;
	/**
	 * Whether `approversInTurn` may name approvers for some call of `tool`, for a rule whose answer
	 * depends on the input. Asked when the input is not known yet, as for a precheck script's call
	 * whose arguments are computed when it runs; a rule with `approversInTurn` and without this is
	 * taken to name approvers for every tool.
	 */
	mayName?(tool: string): boolean;
}

/** The description of a held call with its hold classes. */
export interface ClassedHold {
	description: HoldDescription;
	classes: readonly string[];
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
	 * The classes of the call, from the first rule whose `describe` holds it; see
	 * `HoldRule.holdClasses`. A rule without its own classes classes the call by its name.
	 * Undefined when no rule holds the call. A check made without `holdChain` has none, and yolo
	 * mode then never approves its calls.
	 */
	classesOf?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): readonly string[] | undefined;
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
	): HoldDescription | undefined | Promise<HoldDescription | undefined>;
	/**
	 * `inTurn`, with the classes of the rule that held the call, as the confirmation gate records
	 * them with it; see `HoldRule.holdClasses`. A description that names its own `classes` keeps
	 * them. A check without it has no classes for its calls.
	 */
	inTurnWithClasses?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
	): ClassedHold | undefined | Promise<ClassedHold | undefined>;
	/** The highest tier any rule requires to approve the call; see `HoldRule.approvalTier`. */
	approvalTier?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): Tier | undefined;
	/**
	 * Who may approve the call instead of its speaker, from the rules that name approvers; see
	 * `HoldRule.approversInTurn`. Absent when no rule has the lookup; it answers at once when every
	 * rule asked did, and otherwise as a promise that rejects when a rule's does.
	 */
	approversInTurn?(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
	): readonly string[] | undefined | Promise<readonly string[] | undefined>;
	/** The name of a rule that may name approvers for some call of `tool` whatever its input; see `HoldRule.mayName`. */
	mayName?(tool: string): string | undefined;
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
	check.classesOf = (tool, input, context) => {
		const rule = rules.find(
			(r) => r.describe(tool, input, context) !== undefined,
		);
		return rule && classesFor(rule, tool, input, context);
	};
	/** Asks the rules from `from` in order; the first description holds the call, with the rule that gave it. */
	const ask = (
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
		from: number,
	): Holding | undefined | Promise<Holding | undefined> => {
		for (let at = from; at < rules.length; at++) {
			const rule = rules[at];
			if (!rule) continue;
			const description = rule.describeInTurn
				? rule.describeInTurn(tool, input, context, turn)
				: rule.describe(tool, input, context);
			if (isPromise(description))
				return description.then((found) =>
					found !== undefined
						? { description: found, rule }
						: ask(tool, input, context, turn, at + 1),
				);
			if (description !== undefined) return { description, rule };
		}
		return undefined;
	};
	check.inTurn = (tool, input, context, turn) => {
		const found = ask(tool, input, context, turn, 0);
		return isPromise(found)
			? found.then((holding) => holding?.description)
			: found?.description;
	};
	check.inTurnWithClasses = (tool, input, context, turn) => {
		const classed = (holding: Holding | undefined) =>
			holding && {
				description: holding.description,
				classes: classesIn(holding, tool, input, context),
			};
		const found = ask(tool, input, context, turn, 0);
		return isPromise(found) ? found.then(classed) : classed(found);
	};
	check.mayHold = (tool) => rules.find((rule) => rule.mayHold?.(tool))?.name;
	check.approvalTier = (tool, input, context) =>
		rules.reduce<Tier | undefined>(
			(tier, rule) =>
				higherTier(tier, rule.approvalTier?.(tool, input, context)),
			undefined,
		);
	if (rules.some((rule) => rule.approversInTurn)) {
		check.mayName = (tool) =>
			rules.find(
				(rule) => rule.approversInTurn && (rule.mayName?.(tool) ?? true),
			)?.name;
		check.approversInTurn = (tool, input, context, turn) => {
			const named = rules.flatMap((rule) => {
				const approvers = rule.approversInTurn?.(tool, input, context, turn);
				return approvers === undefined ? [] : [approvers];
			});
			if (named.length === 0) return undefined;
			if (named.some(isPromise))
				return Promise.all(named).then(commonApprovers);
			return commonApprovers(named as (readonly string[] | undefined)[]);
		};
	}
	return check;
}

/** The classes of a call a rule holds: its own, or the rule's name. */
function classesFor(
	rule: HoldRule,
	tool: string,
	input: Record<string, unknown>,
	context: HoldContext,
): readonly string[] {
	let own: readonly string[] | undefined;
	try {
		own = rule.holdClasses?.(tool, input, context);
	} catch {
		// A rule whose classes fail classes its call by its name, which yolo mode treats as unknown.
		own = undefined;
	}
	const named = Array.isArray(own) ? own.filter(isClass) : [];
	return named.length > 0 ? [...new Set(named)] : [rule.name];
}

/** A description and the rule that gave it. */
interface Holding {
	description: HoldDescription;
	rule: HoldRule;
}

/** The classes of a held call: those its description names, else its rule's. */
function classesIn(
	{ description, rule }: Holding,
	tool: string,
	input: Record<string, unknown>,
	context: HoldContext,
): readonly string[] {
	if (typeof description === "object" && description !== null) {
		const named = description.classes;
		if (Array.isArray(named) && named.length > 0 && named.every(isClass))
			return [...new Set(named)];
	}
	return classesFor(rule, tool, input, context);
}

function isClass(id: unknown): id is string {
	return typeof id === "string" && id !== "";
}

/** The principals every list names, in the first list's order; undefined when there are no lists. */
function commonApprovers(
	lists: readonly (readonly string[] | undefined)[],
): readonly string[] | undefined {
	const named = lists.filter((list): list is readonly string[] => !!list);
	const [first, ...rest] = named;
	if (!first) return undefined;
	return first.filter((id) => rest.every((list) => list.includes(id)));
}

/** Whether a hold's answer comes later. */
export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}
