import { Type } from "typebox";
import { freeze } from "../freeze.ts";

/** Hands web research to the cheaper worker model; shared by conversation sessions. */
export const DELEGATE_TOOL = "delegate_task" as const;

export const DELEGATE_TOOL_SPEC = freeze({
	name: DELEGATE_TOOL,
	label: "Delegate task",
	description:
		"Hand research that needs many searches or long reading to a cheaper worker model that has only web search and page reading. It runs in the background, and its report comes back to you in this channel as a new turn, where you answer with it. The worker sees nothing but the task, so write it self-contained: the question, what the answer is for, and what to report. Answer quick lookups yourself.",
	parameters: Type.Object({
		title: Type.String({ description: "A short name for the task." }),
		task: Type.String({ description: "The self-contained task." }),
	}),
});
