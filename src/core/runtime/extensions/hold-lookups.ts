import type { ToolTurn } from "../../define.ts";
import {
	type HoldCheck,
	type HoldContext,
	type HoldDescription,
	isPromise,
} from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import type { ApprovalDetails } from "../../interactions/prompts.ts";

/** The turn a hold that looks things up sees; see `HoldRule.describeInTurn`. */
export interface HoldTurn {
	/** Aborts when the turn stops; a call being described then opens no card. */
	signal?: AbortSignal;
	/** The turn a hold receives, with `signal` as the signal that ends its wait. */
	toolTurn(signal: AbortSignal): ToolTurn;
}

/** The answer of a description wait the turn's stop cut short. */
export const STOPPED = Symbol("stopped");

/** What waiting for a call's description comes to: its text, or the turn stopped first. */
export type Described = HoldDescription | undefined | typeof STOPPED;

/**
 * A held call's description, the text its card offers to copy, and who may approve it instead of
 * the speaker; see `HoldRule.approversInTurn`.
 */
export interface Judgment {
	action: string;
	copy?: NonNullable<ApprovalDetails["copy"]>;
	/** Aborts when the plugin withdraws the call; see `HoldDescription`. */
	supersede?: AbortSignal;
	approvers?: readonly string[];
	/** The card is the speaker's alone; see `HoldDescription`. */
	speakerOnly?: true;
}

export type Judged = Judgment | undefined | typeof STOPPED;

/** Whether `value` is an abort signal, however it was made; anything else a hold answers is ignored. */
function isSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AbortSignal).aborted === "boolean" &&
		typeof (value as AbortSignal).addEventListener === "function"
	);
}

/**
 * A hold's description as the action, the copy and the `supersede` signal it carries. An answer
 * that is neither a text nor a text with a copy still holds the call, under the generic
 * description; a copy that is not a non-empty text and a `supersede` that is not a signal are
 * left out, so a hold that gets them wrong never lets the call run.
 */
export function described(
	answer: HoldDescription,
	tool: string,
): Pick<Judgment, "action" | "copy" | "supersede" | "speakerOnly"> {
	if (typeof answer === "string") return { action: answer };
	if (typeof answer !== "object" || answer === null)
		return { action: messages().holdGeneric(tool) };
	const { text, copy, supersede, approval } = answer;
	if (typeof text !== "string") return { action: messages().holdGeneric(tool) };
	const withdrawal = {
		...(isSignal(supersede) ? { supersede } : {}),
		...(approval === "speaker" ? { speakerOnly: true as const } : {}),
	};
	if (
		!copy ||
		typeof copy !== "object" ||
		typeof copy.text !== "string" ||
		copy.text === ""
	)
		return { action: text, ...withdrawal };
	const label = typeof copy.label === "string" ? copy.label : undefined;
	return {
		action: text,
		copy:
			label === undefined ? { text: copy.text } : { label, text: copy.text },
		...withdrawal,
	};
}

/**
 * What a lookup that answers later comes to: its answer; `fallback` when it rejects or outlasts
 * `timeoutMs`; `STOPPED` when the turn stops first. Whatever the lookup is still doing is
 * aborted when the wait ends.
 */
export function awaited<T>(
	answer: Promise<T>,
	fallback: T,
	lookup: AbortController,
	stop: AbortSignal | undefined,
	timeoutMs: number,
): Promise<T | typeof STOPPED> {
	return new Promise((resolve) => {
		const onStop = () => end(STOPPED);
		const timer = setTimeout(() => end(fallback), timeoutMs);
		let ended = false;
		const end = (found: T | typeof STOPPED) => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			stop?.removeEventListener("abort", onStop);
			lookup.abort();
			resolve(found);
		};
		// Handled first, so a rejection after the wait ended is never left unhandled.
		answer.then(end, () => end(fallback));
		if (stop?.aborted) return end(STOPPED);
		stop?.addEventListener("abort", onStop, { once: true });
	});
}

/**
 * A description joined by the approvers the holds name for a call they hold, looked up as the
 * turn with the same wait as the description; a lookup that rejects or outlasts the timeout names
 * none, so only the owners approve the call. A call no rule holds asks no one.
 */
export function joinApprovers(
	answer: Described | Promise<Described>,
	from: { holds: HoldCheck; context: HoldContext; timeoutMs: number },
	tool: string,
	input: Record<string, unknown>,
	turn: HoldTurn,
): Judged | Promise<Judged> {
	const lookup = from.holds.approversInTurn;
	if (!lookup) return withoutApprovers(answer, tool);
	const join = (action: Described): Judged | Promise<Judged> => {
		if (action === STOPPED || action === undefined) return action;
		const {
			action: text,
			copy,
			supersede,
			speakerOnly,
		} = described(action, tool);
		const controller = new AbortController();
		if (turn.signal?.aborted) controller.abort();
		let named:
			| readonly string[]
			| undefined
			| Promise<readonly string[] | undefined>;
		try {
			named = lookup.call(
				from.holds,
				tool,
				input,
				from.context,
				turn.toolTurn(controller.signal),
			);
		} catch {
			named = [];
		}
		if (!isPromise(named)) {
			controller.abort();
			return {
				action: text,
				...(copy ? { copy } : {}),
				...(supersede ? { supersede } : {}),
				...(speakerOnly ? { speakerOnly } : {}),
				...(named ? { approvers: named } : {}),
			};
		}
		return awaited(named, [], controller, turn.signal, from.timeoutMs).then(
			(approvers) => {
				if (approvers === STOPPED) return STOPPED;
				return {
					action: text,
					...(copy ? { copy } : {}),
					...(supersede ? { supersede } : {}),
					...(speakerOnly ? { speakerOnly } : {}),
					...(approvers ? { approvers } : {}),
				};
			},
		);
	};
	return isPromise(answer) ? answer.then(join) : join(answer);
}

function withoutApprovers(
	answer: Described | Promise<Described>,
	tool: string,
): Judged | Promise<Judged> {
	const wrap = (found: Described): Judged =>
		found === STOPPED || found === undefined ? found : described(found, tool);
	return isPromise(answer) ? answer.then(wrap) : wrap(answer);
}
