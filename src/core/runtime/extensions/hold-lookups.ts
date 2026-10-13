import type { ToolTurn } from "../../define.ts";
import { type HoldCheck, type HoldContext, isPromise } from "../../holds.ts";

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
export type Described = string | undefined | typeof STOPPED;

/** A held call's description with who may approve it instead of the speaker; see `HoldRule.approversInTurn`. */
export type Judged =
	| { action: string; approvers?: readonly string[] }
	| undefined
	| typeof STOPPED;

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
	described: Described | Promise<Described>,
	from: { holds: HoldCheck; context: HoldContext; timeoutMs: number },
	tool: string,
	input: Record<string, unknown>,
	turn: HoldTurn,
): Judged | Promise<Judged> {
	const lookup = from.holds.approversInTurn;
	if (!lookup) return withoutApprovers(described);
	const join = (action: Described): Judged | Promise<Judged> => {
		if (action === STOPPED || action === undefined) return action;
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
			return named ? { action, approvers: named } : { action };
		}
		return awaited(named, [], controller, turn.signal, from.timeoutMs).then(
			(approvers) => {
				if (approvers === STOPPED) return STOPPED;
				return approvers ? { action, approvers } : { action };
			},
		);
	};
	return isPromise(described) ? described.then(join) : join(described);
}

function withoutApprovers(
	described: Described | Promise<Described>,
): Judged | Promise<Judged> {
	const wrap = (action: Described): Judged =>
		action === STOPPED || action === undefined ? action : { action };
	return isPromise(described) ? described.then(wrap) : wrap(described);
}
