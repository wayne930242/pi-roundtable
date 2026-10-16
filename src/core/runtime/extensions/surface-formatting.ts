import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Appends the formatting guidance of the surface the running turn replies on to the system
 * prompt's appended part before each run, after the persona and what earlier handlers appended.
 * Nothing is added when `guidance` returns undefined: a turn whose channel has no surface, a
 * surface without guidance, or no turn running.
 */
export function surfaceFormattingExtension(
	guidance: () => string | undefined,
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			const text = guidance();
			if (text === undefined) return;
			const appended = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = appended
				? `${appended}\n\n${text}`
				: text;
		});
	};
}
