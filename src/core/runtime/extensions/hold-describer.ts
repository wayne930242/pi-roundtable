import { type HoldCheck, type HoldContext, isPromise } from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import {
	awaited,
	type Described,
	type HoldTurn,
	type Judged,
	joinApprovers,
} from "./hold-lookups.ts";

/**
 * Asks a conversation's holds to describe a call a turn makes, and hands each description on in
 * the order the calls were made, whichever comes back first, so calls made together are held,
 * and their cards opened, in that order.
 */
export class HoldDescriber {
	readonly #holds: HoldCheck;
	readonly #context: HoldContext;
	readonly #timeoutMs: number;
	/** Settles when the descriptions asked for so far have all been used, in the order they were asked. */
	#describing: Promise<void> = Promise.resolve();
	/** Descriptions asked for and not used yet. */
	#undescribed = 0;

	/** A hold that looks things up gets `timeoutMs` to answer before its call is held under a generic description. */
	constructor(holds: HoldCheck, context: HoldContext, timeoutMs: number) {
		this.#holds = holds;
		this.#context = context;
		this.#timeoutMs = timeoutMs;
	}

	/**
	 * The call's description with the approvers the holds name, handed to `use` when every
	 * description asked for before it has been used; at once when none is outstanding and the
	 * holds answered at once. The holds must have an `inTurn` check.
	 */
	describe<R>(
		tool: string,
		input: Record<string, unknown>,
		turn: HoldTurn,
		use: (judged: Judged) => R,
	): R | Promise<R> {
		const controller = new AbortController();
		if (turn.signal?.aborted) controller.abort();
		let answer: ReturnType<NonNullable<HoldCheck["inTurn"]>>;
		try {
			answer = this.#holds.inTurn?.call(
				this.#holds,
				tool,
				input,
				this.#context,
				turn.toolTurn(controller.signal),
			);
		} catch {
			answer = messages().holdGeneric(tool);
		}
		const found: Described | Promise<Described> = isPromise(answer)
			? awaited(
					answer,
					messages().holdGeneric(tool),
					controller,
					turn.signal,
					this.#timeoutMs,
				)
			: answer;
		return this.#inOrder(
			joinApprovers(
				found,
				{
					holds: this.#holds,
					context: this.#context,
					timeoutMs: this.#timeoutMs,
				},
				tool,
				input,
				turn,
			),
			use,
		);
	}

	#inOrder<T, R>(
		described: T | Promise<T>,
		use: (described: T) => R,
	): R | Promise<R> {
		if (this.#undescribed === 0 && !isPromise(described)) return use(described);
		this.#undescribed++;
		const used = this.#describing.then(() => described).then(use);
		this.#describing = used.then(
			() => {
				this.#undescribed--;
			},
			() => {
				this.#undescribed--;
			},
		);
		return used;
	}
}
