import type { GateStepView } from "../../src/api-types.ts";
import { translate as t } from "./messages.ts";

/**
 * What a step is called. The steps the app makes itself are worded here, in the page's language;
 * a step a host registered carries its own words.
 */
export function stepLabel(
	step: Pick<GateStepView, "builtin" | "label">,
): string {
	if (step.builtin === "link")
		return t("Link your {name} account", { name: step.label });
	if (step.builtin === "push") return t("Turn on notifications");
	return step.label;
}

/** The line under a step's name. */
export function stepHelp(
	step: Pick<GateStepView, "builtin" | "help" | "required">,
): string {
	if (step.help) return step.help;
	if (step.builtin === "link")
		return t(
			"Prove which account is yours, so the app knows who you are there.",
		);
	if (step.builtin === "push")
		return t(
			"So that you hear when something needs you, even when the app is closed.",
		);
	return "";
}
