import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Puts the agent's current prompt first in the system prompt's appended part before each run,
 * keeping what earlier handlers appended, such as the owner memory section.
 */
export function agentPromptExtension(prompt: () => string): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			const appended = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = appended
				? `${prompt()}\n\n${appended}`
				: prompt();
		});
	};
}
