import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiTurnContext } from "../src/pi-protocol.ts";

/**
 * Adds what the channel keeps about the current speaker to this run's system prompt. The
 * prompt is rebuilt every run, so the session history never piles up stale copies.
 */
export function speakerMemoryExtension(
	turn: () => PiTurnContext,
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			const { memory } = turn();
			if (!memory) return;
			const current = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = current
				? `${current}\n\n${memory}`
				: memory;
		});
	};
}
