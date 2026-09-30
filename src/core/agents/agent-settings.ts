import { AgentError } from "../domain/errors.ts";
import { assistantName } from "../i18n/index.ts";
import {
	AUTO_THINKING,
	type ThinkingLevel,
	type ThinkingSetting,
} from "../models.ts";
import { checkModelRef, checkThinking } from "./agent-store.ts";

/** Resets a model or thinking setting to the assistant's. */
const DEFAULT_SETTING = "default";

/** A thinking setting in words, for agents reading one. */
export function describeThinking(setting: ThinkingSetting): string {
	return setting === AUTO_THINKING
		? "auto, the judge picks each turn's level"
		: setting;
}

/**
 * The model an update sets: unchanged when absent, null for the assistant's, otherwise one the host
 * runs.
 */
export async function modelSetting(
	model: string | undefined,
	usable: () => Promise<string[]>,
): Promise<string | null | undefined> {
	if (model === undefined) return undefined;
	const value = model.trim();
	if (value === DEFAULT_SETTING) return null;
	checkModelRef(value);
	const models = await usable();
	if (!models.includes(value))
		throw new AgentError(
			`${assistantName()} cannot run ${value}. Usable models: ${models.join(", ")}; or "default" for ${assistantName()}'s.`,
		);
	return value;
}

/** The thinking level an update sets: unchanged when absent, null for the assistant's. */
export function thinkingSetting(
	level: string | undefined,
): ThinkingLevel | null | undefined {
	if (level === undefined) return undefined;
	const value = level.trim();
	if (value === DEFAULT_SETTING) return null;
	checkThinking(value);
	return value;
}
