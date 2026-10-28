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
 * `HoldRule.holdClasses`); a rule that leaves them out leaves its call unclassed.
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
	/**
	 * Whether the rule stands for other rules' calls, as the precheck scripts' does, and may report
	 * their ids in `holdClasses`. Any other rule may report only ids that start with its own name
	 * and a dot. A relay's calls also carry `<name>.relay`, so `autonomy.yolo.card` naming the relay
	 * cards them.
	 */
	relay?: true;
	describe(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): string | undefined;
	/**
	 * The classes of a call this rule holds, as `<rule>.<class>` ids such as `shell.rm`, for yolo
	 * mode to tell a call it may approve from one it never does (see `autonomy.yolo`). Report only
	 * classes that are safe to approve with no person looking: listing a class opts the call in, and
	 * yolo then approves it unless `autonomy.yolo.card` names the class or the rule. List every
	 * reason the call is held, not only the first: yolo approves only a call whose classes it all
	 * allows. Every id starts with the rule's name and a dot; a `relay` rule, which stands for other
	 * rules' calls, may list their ids instead. A rule that reports none,
	 * or an id that is not so named, leaves the call unclassed: yolo cards it unless
	 * `autonomy.yolo.allow` names the rule. Asked for a call `describe` held. It must change nothing.
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
	 * The classes of the call, from every rule whose `describe` holds it; see
	 * `HoldRule.holdClasses`. A rule without valid classes of its own gives its bare name, which
	 * marks the call unclassed. Undefined when no rule holds the call. A check made without `holdChain` has none, and yolo
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
	 * `inTurn`, with the classes of every rule that holds the call, as the confirmation gate records
	 * them with it; see `HoldRule.holdClasses`. The rules after the first that holds the call are
	 * asked too, and one whose lookup fails leaves its bare name. A description that names its own
	 * `classes` keeps them. A check without it has no classes for its calls.
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
		if (rule.name.includes("."))
			throw new PluginError(
				`hold rule ${rule.name}: the name has a dot, which separates a rule from its hold classes. Rename it.`,
			);
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
		const holding = rules.filter(
			(r) => r.describe(tool, input, context) !== undefined,
		);
		return holding.length === 0
			? undefined
			: unionOf(
					holding.map((rule) => classesFor(rule, names, tool, input, context)),
				);
	};
	/**
	 * Asks the rules from `from` in order, each holding rule joining `found`. Stops at the first
	 * holding rule unless `all`; then a later rule whose lookup fails holds the call undescribed.
	 */
	const ask = (
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
		turn: ToolTurn,
		from: number,
		all: boolean,
		found: readonly Holding[] = [],
	): readonly Holding[] | Promise<readonly Holding[]> => {
		let holding = found;
		for (let at = from; at < rules.length; at++) {
			const rule = rules[at];
			if (!rule) continue;
			let description: ReturnType<NonNullable<HoldRule["describeInTurn"]>>;
			try {
				description = rule.describeInTurn
					? rule.describeInTurn(tool, input, context, turn)
					: rule.describe(tool, input, context);
			} catch (error) {
				if (holding.length === 0) throw error;
				holding = [...holding, { description: undefined, rule }];
				continue;
			}
			if (isPromise(description)) {
				const before = holding;
				return description.then(
					(answer) => {
						const next =
							answer === undefined
								? before
								: [...before, { description: answer, rule }];
						return all || next.length === 0
							? ask(tool, input, context, turn, at + 1, all, next)
							: next;
					},
					(error) => {
						if (before.length === 0) throw error;
						return ask(tool, input, context, turn, at + 1, all, [
							...before,
							{ description: undefined, rule },
						]);
					},
				);
			}
			if (description !== undefined) {
				holding = [...holding, { description, rule }];
				if (!all) return holding;
			}
		}
		return holding;
	};
	check.inTurn = (tool, input, context, turn) => {
		const found = ask(tool, input, context, turn, 0, false);
		return isPromise(found)
			? found.then((holding) => holding[0]?.description)
			: found[0]?.description;
	};
	check.inTurnWithClasses = (tool, input, context, turn) => {
		const classed = (holding: readonly Holding[]) => {
			const first = holding.find((held) => held.description !== undefined);
			if (first?.description === undefined) return undefined;
			return {
				description: first.description,
				classes: unionOf(
					holding.map((held) => classesIn(held, names, tool, input, context)),
				),
			};
		};
		const found = ask(tool, input, context, turn, 0, true);
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

/** The classes of a call a rule holds: its own, or the rule's bare name, which leaves the call unclassed. */
function classesFor(
	rule: HoldRule,
	names: ReadonlySet<string>,
	tool: string,
	input: Record<string, unknown>,
	context: HoldContext,
): readonly string[] {
	let own: unknown;
	try {
		own = rule.holdClasses?.(tool, input, context);
	} catch {
		// A rule whose classes fail leaves its call unclassed.
		own = undefined;
	}
	return validClasses(own, rule, names);
}

/**
 * The ids a rule reports once each, when it reports some and every one starts with the name of a
 * rule of the chain and a dot or is that name; otherwise the rule's bare name, which yolo mode
 * treats as unclassed and cards.
 */
function validClasses(
	reported: unknown,
	rule: HoldRule,
	names: ReadonlySet<string>,
): readonly string[] {
	if (!Array.isArray(reported) || reported.length === 0) return [rule.name];
	const ids = reported as unknown[];
	if (!ids.every((id): id is string => isClassOf(id, rule, names)))
		return [rule.name];
	return [
		...new Set(rule.relay ? [...ids, `${rule.name}.relay`] : ids),
	] as string[];
}

/** A rule's description, if it gave one, and the rule; a rule whose lookup failed has none. */
interface Holding {
	description: HoldDescription | undefined;
	rule: HoldRule;
}

/** The classes of a held call: those its description names, else its rule's. */
function classesIn(
	{ description, rule }: Holding,
	names: ReadonlySet<string>,
	tool: string,
	input: Record<string, unknown>,
	context: HoldContext,
): readonly string[] {
	// A rule whose lookup failed could not say what the call is.
	if (description === undefined) return [rule.name];
	if (typeof description === "object" && description !== null) {
		const named = description.classes;
		if (Array.isArray(named) && named.length > 0)
			return validClasses(named, rule, names);
	}
	return classesFor(rule, names, tool, input, context);
}

/**
 * Whether a rule may report the id: it is the rule's own name or one of its classes, or the rule
 * is a relay and the id is a rule of the chain or one of that rule's classes.
 */
function isClassOf(
	id: unknown,
	rule: HoldRule,
	names: ReadonlySet<string>,
): id is string {
	if (typeof id !== "string") return false;
	const dot = id.indexOf(".");
	const owner = dot === -1 ? id : id.slice(0, dot);
	return rule.relay ? names.has(owner) : owner === rule.name;
}

/** The ids of the lists once each, in order. */
function unionOf(lists: readonly (readonly string[])[]): readonly string[] {
	return [...new Set(lists.flat())];
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
