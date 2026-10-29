import type { GateStepView } from "./api-types.ts";
import type { Viewer, WebAppRegistry } from "./web-app.ts";

/** How long a person's owed steps are remembered, so a page of requests asks each step once. */
const MEMO_MS = 5_000;

export interface GateOptions {
	registry: Pick<WebAppRegistry, "steps" | "waived">;
	/** The clock, in milliseconds; default `Date.now`. */
	now?: () => number;
}

interface Memo {
	at: number;
	steps: GateStepView[];
}

/**
 * The onboarding gate. A person owes a step when it applies to them and is neither done nor
 * waived. While they owe a required step, only the routes marked G and the few frames a gated
 * socket may have answer them; the rest answer 403 with `gate: true`. A step that cannot be read
 * counts as undone, so a failing lookup keeps the gate shut rather than opening it.
 */
export class Gate {
	readonly #options: GateOptions;
	readonly #memo = new Map<string, Memo>();
	readonly #listeners = new Set<(principalId: string) => void>();

	constructor(options: GateOptions) {
		this.#options = options;
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	/** The steps this viewer still owes, required or not, in the order they were registered. */
	async owed(viewer: Viewer): Promise<GateStepView[]> {
		const found = this.#memo.get(viewer.principalId);
		if (found && this.#now() - found.at < MEMO_MS) return found.steps;
		const steps: GateStepView[] = [];
		for (const step of this.#options.registry.steps()) {
			try {
				if (step.applies && !(await step.applies(viewer))) continue;
				if (await step.done(viewer)) continue;
				const waived = step.required
					? await this.#options.registry.waived(viewer.principalId, step.id)
					: false;
				if (waived) continue;
				steps.push({
					id: step.id,
					label: step.label,
					...(step.help ? { help: step.help } : {}),
					...(step.builtin ? { builtin: step.builtin } : {}),
					required: step.required,
					open: step.open,
					...(step.required && step.waiver ? { waiver: step.waiver } : {}),
				});
			} catch {
				// A step that cannot be read is undone; a required one keeps the gate shut.
				steps.push({
					id: step.id,
					label: step.label,
					...(step.builtin ? { builtin: step.builtin } : {}),
					required: step.required,
					open: step.open,
				});
			}
		}
		this.#memo.set(viewer.principalId, { at: this.#now(), steps });
		return steps;
	}

	/** Whether a required step stands undone; the steps it names are those. */
	async required(viewer: Viewer): Promise<GateStepView[]> {
		return (await this.owed(viewer)).filter((step) => step.required);
	}

	/** A person's steps may differ now (they linked an account, waived a step): ask again. */
	changed(principalId: string): void {
		this.#memo.delete(principalId);
		for (const listener of this.#listeners) listener(principalId);
	}

	/** Hears of a change to a person's steps, so their open sockets can be told. */
	onChanged(listener: (principalId: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
