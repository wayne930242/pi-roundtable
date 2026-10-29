import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Brings the persona in the system prompt up to date before each run. The session was built with
 * `initial`, the persona's text at that moment; when `current()` reads differently now, such as a
 * prompt document the owner edited in the app, this run carries the new text in the same place.
 */
export function personaPromptExtension(
	initial: string,
	current: () => string,
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			const now = current();
			if (now === initial) return;
			const appended = event.systemPromptOptions.appendSystemPrompt;
			if (!appended) {
				event.systemPromptOptions.appendSystemPrompt = now;
				return;
			}
			event.systemPromptOptions.appendSystemPrompt =
				initial === ""
					? `${now}\n\n${appended}`
					: appended.split(initial).join(now);
		});
	};
}
