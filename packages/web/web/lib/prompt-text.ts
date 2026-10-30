import { translate as t, wording } from "./messages.ts";

/** The label and description the core gives the prompt documents it registers, marked so the catalog covers them. */
const CORE: Record<string, string> = {
	"Shared prompt": wording("Shared prompt"),
	"Guest prompt": wording("Guest prompt"),
	"The base every knight's prompt starts with, the main knight's included.":
		wording(
			"The base every knight's prompt starts with, the main knight's included.",
		),
	"Used instead of the shared prompt when the person speaking is not the owner.":
		wording(
			"Used instead of the shared prompt when the person speaking is not the owner.",
		),
};

/** A prompt document's label or description: the catalog's wording for the core's own, and a plugin's as it wrote it. */
export const promptText = (source: string): string => t(CORE[source] ?? source);
