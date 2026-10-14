import type { HeldCall } from "../../domain/conversation.ts";

/**
 * One held call whose plugin may withdraw it (`HoldDescription.supersede`), for as long as the
 * call can still run: while its card is open or answered late, while it waits for a message that
 * confirms it, and while an approval waits for the call to be made.
 */
export interface Watch {
	readonly call: HeldCall;
	/** The plugin's signal, which the card of the call is given to close by. */
	readonly signal: AbortSignal;
	/** Whether the plugin withdrew the call; the call was forgotten when this turned true. */
	readonly withdrawn: boolean;
	/** Settles once the plugin withdraws the call, never otherwise. */
	readonly whenWithdrawn: Promise<"withdrawn">;
	/** Whether a card of the call can still be answered; a watch without one lasts as long as the call is kept. */
	card: boolean;
	/** Stops watching: the call ran, was refused, or is no longer kept. Does nothing after a withdrawal. */
	end(): void;
}

/**
 * The calls a conversation's gate holds that their plugins may withdraw. Withdrawing is the one
 * transition a call makes from "may run" to "may not", taken by whichever of the plugin's abort
 * and the call's release (an approval spending it) comes first; a watch that ended or withdrew
 * is gone from here, so nothing is kept for a call that can no longer be withdrawn.
 */
export class Withdrawals {
	readonly #watches = new Set<Watch>();
	readonly #forget: (call: HeldCall) => void;

	/** `forget` drops a withdrawn call from everything that could still run it. */
	constructor(forget: (call: HeldCall) => void) {
		this.#forget = forget;
	}

	/** How many calls are watched now. */
	get size(): number {
		return this.#watches.size;
	}

	/**
	 * Watches `call` for `signal`. A signal that is already aborted withdraws it at once: the
	 * returned watch is `withdrawn`, and the call is forgotten.
	 */
	watch(call: HeldCall, signal: AbortSignal): Watch {
		let withdrawn = false;
		let resolve: (value: "withdrawn") => void = () => {};
		const whenWithdrawn = new Promise<"withdrawn">((done) => {
			resolve = done;
		});
		const watches = this.#watches;
		const forget = this.#forget;
		const withdraw = () => {
			if (withdrawn || !watches.delete(watch)) return;
			withdrawn = true;
			forget(call);
			resolve("withdrawn");
		};
		const watch: Watch = {
			call,
			signal,
			get withdrawn() {
				return withdrawn;
			},
			whenWithdrawn,
			card: true,
			end() {
				if (!watches.delete(watch)) return;
				signal.removeEventListener("abort", withdraw);
			},
		};
		watches.add(watch);
		if (signal.aborted) withdraw();
		else signal.addEventListener("abort", withdraw, { once: true });
		return watch;
	}

	/** Ends the watches of `call`, which was released or refused: the same object, as the gate holds it. */
	endCall(call: HeldCall): void {
		for (const watch of [...this.#watches])
			if (watch.call === call) watch.end();
	}

	/** Ends every watch, for a gate that is dropped. */
	clear(): void {
		for (const watch of [...this.#watches]) watch.end();
	}

	/** Ends the watches whose call is no longer kept (`kept`) and whose card is closed. */
	sweep(kept: (call: HeldCall) => boolean): void {
		for (const watch of [...this.#watches])
			if (!watch.card && !kept(watch.call)) watch.end();
	}
}
