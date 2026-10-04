import type { OwnerPrompts, OwnerQuestion } from "../domain/owner-prompts.ts";
import { assistantName } from "../i18n/index.ts";

/**
 * A run's way to ask the owner while it works. A turn they started or a report turn binds the
 * cards of its channel, and a coding worker those of its dispatch thread; a schedule's turn, or
 * a session with no Discord channel, leaves the slot empty and held actions wait for their next
 * message instead. The slot also counts how long the run waited on them, which its time limit
 * leaves out.
 */
export class PromptSlot {
	#prompts: OwnerPrompts | undefined;
	#beforeCard: (() => Promise<void>) | undefined;
	#asker = assistantName();
	#open = 0;
	#openSince = 0;
	#waited = 0;

	/**
	 * Binds the turn's prompts; `asker` names who asks, the assistant or an agent. `beforeCard`
	 * runs before each card opens, such as posting the text the turn wrote before it.
	 */
	bind(
		prompts: OwnerPrompts | undefined,
		asker: string,
		beforeCard?: () => Promise<void>,
	): void {
		this.#prompts = prompts;
		this.#beforeCard = beforeCard;
		this.#asker = asker;
		this.#open = 0;
		this.#waited = 0;
	}

	unbind(): void {
		this.#prompts = undefined;
		this.#beforeCard = undefined;
	}

	get asker(): string {
		return this.#asker;
	}

	/** The turn's prompts, each open card counted as waiting; undefined when none is bound. */
	get prompts(): OwnerPrompts | undefined {
		const prompts = this.#prompts;
		if (!prompts) return undefined;
		return {
			confirm: (title, message, signal) =>
				this.#waiting(() => prompts.confirm(title, message, signal)),
			ask: (title, question: OwnerQuestion, signal) =>
				this.#waiting(() => prompts.ask(title, question, signal)),
		};
	}

	/** Time this turn has spent with at least one card open. */
	waitedMs(now = Date.now()): number {
		return this.#waited + (this.#open > 0 ? now - this.#openSince : 0);
	}

	async #waiting<T>(ask: () => Promise<T>): Promise<T> {
		await this.#beforeCard?.();
		if (this.#open++ === 0) this.#openSince = Date.now();
		try {
			return await ask();
		} finally {
			if (--this.#open === 0) this.#waited += Date.now() - this.#openSince;
		}
	}
}

/** A fresh slot, for a run that asks the owner while it works. */
export function promptSlot(): PromptSlot {
	return new PromptSlot();
}

/**
 * Calls `expire` once the run has worked `ms`, not counting time the slot spent waiting on the
 * owner's cards; returns a function that cancels it.
 */
export function workTimeout(
	ms: number,
	slot: Pick<PromptSlot, "waitedMs">,
	expire: () => void,
): () => void {
	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = (delay: number) => {
		timer = setTimeout(() => {
			const left = ms - (Date.now() - started - slot.waitedMs());
			if (left > 0) return arm(left);
			expire();
		}, delay);
	};
	arm(ms);
	return () => clearTimeout(timer);
}
