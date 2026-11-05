import { Type } from "typebox";
import { THINKING_LEVELS } from "../domain/models.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import {
	optionalString,
	requiredString,
	stringList,
	type TextToolDef,
} from "../runtime/text-tools.ts";
import { CLASS, COLOR, DISPLAY, lookOf, PROMPT } from "./agent-tool-schema.ts";
import type { AgentOps } from "./agent-tools.ts";

export const MODEL = Type.String({
	description:
		"The model to run on, as <provider>/<model>; left out, yours. An unusable one is refused with the usable list.",
});
export const THINKING = Type.Union(
	[...THINKING_LEVELS, "default"].map((level) => Type.Literal(level)),
	{ description: "Its thinking level; left out, yours." },
);
const PRESET_NAME = Type.String({
	pattern: "^[a-z0-9-]{1,32}$",
	description: "The preset's name: lowercase letters, digits, and dashes.",
});

/** The tools that keep a knight's temp-knight presets, which only it sees and uses. */
export function helperPresetToolDefs(
	ops: Pick<AgentOps, "helperPreset">,
	scope: AgentTurnScope,
	skillsOn: boolean,
): TextToolDef<
	"helper_preset_set" | "helper_preset_list" | "helper_preset_delete"
>[] {
	return [
		{
			name: "helper_preset_set",
			label: "Save temp knight preset",
			description:
				"Save a temp knight you make often (its role prompt, skills, and look) as a preset, then make it with helper_create and preset instead of writing them again. Saving under a name you have replaces that preset whole. Only you see and use your presets; you may keep 20.",
			parameters: Type.Object({
				name: PRESET_NAME,
				display_name: DISPLAY,
				prompt: PROMPT,
				class: Type.Optional(CLASS),
				color: Type.Optional(COLOR),
				model: Type.Optional(MODEL),
				thinking: Type.Optional(THINKING),
				...(skillsOn
					? {
							skills: Type.Optional(
								Type.Array(Type.String(), {
									description:
										"Skills its temp knight carries, from skill_list.",
								}),
							),
						}
					: {}),
			}),
			run: (i) => {
				const look = lookOf(i);
				const model = optionalString(i, "model");
				const thinking = optionalString(i, "thinking");
				return ops.helperPreset(scope, {
					kind: "set",
					preset: {
						name: requiredString(i, "name"),
						displayName: requiredString(i, "display_name"),
						prompt: requiredString(i, "prompt"),
						skills: [...new Set(stringList(i, "skills") ?? [])],
						...(Object.keys(look).length > 0 ? { character: look } : {}),
						...(model ? { model } : {}),
						...(thinking ? { thinking } : {}),
					},
				});
			},
		},
		{
			name: "helper_preset_list",
			label: "List temp knight presets",
			description:
				"List your temp knight presets, one line each; with a name, show that preset in full.",
			parameters: Type.Object({
				name: Type.Optional(
					Type.String({ description: "A preset to show in full." }),
				),
			}),
			run: (i) => {
				const name = optionalString(i, "name");
				return ops.helperPreset(scope, {
					kind: "list",
					...(name ? { name } : {}),
				});
			},
		},
		{
			name: "helper_preset_delete",
			label: "Delete temp knight preset",
			description: "Delete one of your temp knight presets.",
			parameters: Type.Object({
				name: Type.String({ description: "The preset's name." }),
			}),
			run: (i) =>
				ops.helperPreset(scope, {
					kind: "delete",
					name: requiredString(i, "name"),
				}),
		},
	];
}
