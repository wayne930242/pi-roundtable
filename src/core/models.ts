import { messages } from "./i18n/index.ts";
/** Models and thinking levels as Pi names them, and the settings built on them. */

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

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

/** Picks one turn's thinking level from its message and the previous turn's reply and level. */
export interface ThinkingPicker {
	judge(
		message: string,
		previous?: { reply?: string; level?: ThinkingLevel },
	): Promise<ThinkingLevel>;
}
