import type { RuntimeFactory } from "./runtime.ts";

/** A choice among named options; the answer is one option's name. */
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ChoiceAnswer {
	choice: string;
	confidence: number;
}

/** A yes-or-no question; the answer is the probability of yes. */
export interface YesNoQuestion {
	type: "yesno";
	instructions: string;
	criteria?: { true?: string; false?: string };
}

/** An ordinal question; the answer is a probability for each criterion, in order. */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: readonly string[];
}

/**
 * Small judgments about a state: whether a reply approves held actions, how hard a turn is,
 * which agents a group message concerns. Every method throws when it cannot answer; callers
 * fall back to their own default.
 */
export interface Judge {
	askYesNo(
		state: Record<string, unknown>,
		questions: Record<string, YesNoQuestion>,
	): Promise<Record<string, number>>;
	askChoice(
		state: Record<string, unknown>,
		name: string,
		question: ChoiceQuestion,
	): Promise<ChoiceAnswer>;
	/** Probabilities indexed like the criteria. */
	askScore(
		state: Record<string, unknown>,
		name: string,
		question: ScoreQuestion,
	): Promise<number[]>;
}

/** An image to draw from. */
export interface ReferenceImage {
	/** Base64 bytes. */
	data: string;
	mimeType: string;
}

/** Draws one image from a prompt and reference images; returns PNG or other decodable bytes. */
export type ImageDrawer = (
	prompt: string,
	references: readonly ReferenceImage[],
) => Promise<Uint8Array>;

/** The replaceable parts the core runs on; a plugin provides at most the ones it replaces. */
export interface Providers {
	judge: Judge;
	images: ImageDrawer;
	/**
	 * Builds the runtime that runs the agent server's conversations and every turn run through
	 * `context.turns`, in place of the Pi runtime. The default refuses: the host's runtime plugin
	 * builds the Pi runtime itself when no plugin fills this slot. Read the running runtime from
	 * `services.get(RUNTIME)` rather than calling this.
	 */
	runtime: RuntimeFactory;
}

/**
 * Each slot as the host resolved it, and which slots a plugin fills. A slot no plugin fills holds
 * the core's default, and `filled` is how a caller tells that default from a provider without
 * calling it.
 */
export interface ResolvedProviders extends Providers {
	readonly filled: ReadonlySet<keyof Providers>;
}
