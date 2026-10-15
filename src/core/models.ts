import { messages } from "./i18n/index.ts";
import type { ChannelKey } from "./sessions.ts";
/** Models and thinking levels as Pi names them, and the settings built on them. */

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export const THINKING_LEVELS: readonly ThinkingLevel[] = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

/** An agent's or the assistant's thinking setting: a fixed level, or the judge's choice each turn. */
export const AUTO_THINKING = "auto";
export type ThinkingSetting = ThinkingLevel | typeof AUTO_THINKING;

/** A thinking setting as the owner reads it in Discord. */
export function thinkingLabel(setting: ThinkingSetting): string {
	return setting === AUTO_THINKING ? messages().thinkingAuto : setting;
}

/** A model as Pi's model runtime looks it up; written `<provider>/<id>`. */
export interface ModelRef {
	provider: string;
	id: string;
}

/** `<provider>/<id>` as a ModelRef, or undefined when either part is missing. */
export function parseModelRef(text: string): ModelRef | undefined {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return undefined;
	return { provider: text.slice(0, slash), id: text.slice(slash + 1) };
}

export const formatModelRef = (model: ModelRef): string =>
	`${model.provider}/${model.id}`;

/** What a host's effort policy is told about a turn that thinks at the judge's choice. */
export interface EffortRequest {
	/** Where the turn's message arrived, as `<surface>:<channel id>`. */
	channel: ChannelKey;
	/** The conversation's kind, as a claim's `startFresh` set it; "owner" when absent. */
	kind?: string;
	/** The agent-server agent's name, for an agent's turn. */
	agent?: string;
	/** Where the request came from, as the transport knows it; see `TurnRequest.origin`. */
	origin?: string;
}

/**
 * How one turn's level is chosen, instead of the default. `fixed` runs the turn at that level
 * without asking the judge. `requiredMass` asks the judge and runs the highest level whose share
 * of the answer at or above it meets its entry (index 0 is low and never read; 1 medium, 2 high,
 * 3 xhigh); the previous turn's level does not carry over, and a judge that fails gives low.
 */
export type EffortRule =
	| { fixed: ThinkingLevel }
	| { requiredMass: readonly [number, number, number, number] };

/** Picks the rule of a turn, or undefined for the default (sticky judging with the host's threshold). */
export type EffortPolicy = (request: EffortRequest) => EffortRule | undefined;

/** Picks one turn's thinking level from its message and the previous turn's reply and level. */
export interface ThinkingPicker {
	judge(
		message: string,
		previous?: { reply?: string; level?: ThinkingLevel },
		rule?: Exclude<EffortRule, { fixed: ThinkingLevel }>,
	): Promise<ThinkingLevel>;
}
