import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../../log.ts";
import { readPromptOrStop } from "./prompt-read.ts";

/**
 * Puts the agent's current prompt first in the system prompt's appended part before each run,
 * keeping what earlier handlers appended, such as the owner memory section. A `prompt()` that
 * throws is logged as an error and stops the run: an agent never runs without its prompt.
 */
export function agentPromptExtension(
	prompt: () => string,
	logger: Logger,
	/** The agent's name, named in the log. */
	agent: string,
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event, ctx) => {
			const text = readPromptOrStop(
				prompt,
				ctx,
				logger,
				`The prompt of the agent "${agent}"`,
			);
			if (text === undefined) return;
			const appended = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = appended
				? `${text}\n\n${appended}`
				: text;
		});
	};
}
