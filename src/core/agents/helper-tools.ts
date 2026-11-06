import { Type } from "typebox";
import type { AgentTurnScope } from "../domain/ports.ts";
import {
	optionalString,
	requiredString,
	stringList,
	type TextToolDef,
} from "../runtime/text-tools.ts";
import { MAX_PROMPT_CHARS } from "./agent-rules.ts";
import { CLASS, COLOR, lookOf } from "./agent-tool-schema.ts";
import type { AgentOps, HELPER_TOOLS } from "./agent-tools.ts";
import {
	helperPresetToolDefs,
	MODEL,
	THINKING,
} from "./helper-preset-tools.ts";

/** The tools that make and end a knight's temp knights. */
export function helperToolDefs(
	ops: AgentOps,
	scope: AgentTurnScope,
	skillsOn: boolean,
): TextToolDef<(typeof HELPER_TOOLS)[number]>[] {
	return [
		{
			name: "helper_create",
			label: "Create temp knight",
			description: `Make a temp knight (a helper knight) for one self-contained task that can run on its own, such as one of several things to look up or compare. It is a real agent with its own picture and place, listed under you; it starts at once and its answer comes back to you here as a new turn, like message_agent's. Make one per task, then end your turn; when the answers are in, merge them and clear the ones that are done with helper_end. It runs your model unless you give one, cannot make knights, temp knights or groups, and has no schedules. You may have a few at once, and when you are at the limit your oldest finished one is archived to make room. Before making a temp knight, check helper_preset_list for a preset to recruit it from and recruit with helper_create and preset when one fits; write a new one only otherwise. A temp knight recruited from a preset takes what you leave out from it: what you give in the call replaces the preset's, and skills you give are added to the preset's. Save one you make often with helper_preset_set.`,
			parameters: Type.Object({
				preset: Type.Optional(
					Type.String({
						description:
							"The preset to recruit it from, from helper_preset_list: your own by its name, or a shared one as <agent>/<name>; it gives what you leave out here.",
					}),
				),
				display_name: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: 32,
						description:
							"The name shown on its messages; any language. Required unless a preset gives it; given, it replaces the preset's.",
					}),
				),
				prompt: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: MAX_PROMPT_CHARS,
						description:
							"Its role prompt, in English: its job, sources, boundaries, and how it reports. Required unless a preset gives it; given, it replaces the preset's.",
					}),
				),
				task: Type.String({
					minLength: 1,
					maxLength: 4000,
					description:
						"The task, self-contained: what to do, what to read, and what to answer with.",
				}),
				name: Type.Optional(
					Type.String({
						pattern: "^[a-z0-9-]{1,32}$",
						description:
							"Permanent name: lowercase letters, digits, and dashes. Left out, it is <your name>-<number>.",
					}),
				),
				class: Type.Optional(CLASS),
				color: Type.Optional(COLOR),
				model: Type.Optional(MODEL),
				thinking: Type.Optional(THINKING),
				...(skillsOn
					? {
							skills: Type.Optional(
								Type.Array(Type.String(), {
									description:
										"Skills it carries, from skill_list; pick those the task needs. With a preset, added to the preset's.",
								}),
							),
						}
					: {}),
			}),
			run: (i) => {
				const name = optionalString(i, "name");
				const model = optionalString(i, "model");
				const thinking = optionalString(i, "thinking");
				const skills = stringList(i, "skills");
				const look = lookOf(i);
				const preset = optionalString(i, "preset");
				const displayName = optionalString(i, "display_name");
				const prompt = optionalString(i, "prompt");
				return ops.helperCreate(scope, {
					...(preset ? { preset } : {}),
					...(displayName ? { displayName } : {}),
					...(prompt ? { prompt } : {}),
					task: requiredString(i, "task"),
					...(name ? { name } : {}),
					...(Object.keys(look).length > 0 ? { character: look } : {}),
					...(model ? { model } : {}),
					...(thinking ? { thinking } : {}),
					...(skills && skills.length > 0 ? { skills } : {}),
				});
			},
		},
		{
			name: "helper_end",
			label: "End temp knights",
			description:
				'Archive your own temp knights when you are done with them: the names you list, or "finished" for every one that has finished. Their history stays readable under the archive, and the owner can restore them. You cannot end anyone else\'s.',
			parameters: Type.Object({
				names: Type.Union(
					[
						Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
						Type.Literal("finished"),
					],
					{ description: 'Their names, or "finished" for every finished one.' },
				),
			}),
			run: (i) =>
				ops.helperEnd(
					scope,
					i.names === "finished" ? "finished" : (stringList(i, "names") ?? []),
				),
		},
		...helperPresetToolDefs(ops, scope, skillsOn),
	];
}
