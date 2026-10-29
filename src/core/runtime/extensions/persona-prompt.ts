import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../../log.ts";
import { readPromptOrStop } from "./prompt-read.ts";

/**
 * Brings the persona in the system prompt up to date before each run. The session was built with
 * `initial`, the persona's text at that moment; when `current()` reads differently now, such as a
 * prompt document the owner edited in the app, this run carries the new text in the same place.
 * A `current()` that throws is logged as an error and stops the run: it does not go on with the
 * text the session was built with.
 */
export function personaPromptExtension(
	initial: string,
	current: () => string,
	logger: Logger,
	/** The conversation kind, named in the log. */
	kind: string,
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event, ctx) => {
			const now = readPromptOrStop(
				current,
				ctx,
				logger,
				`The persona of the "${kind}" conversations`,
			);
			if (now === undefined || now === initial) return;
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
