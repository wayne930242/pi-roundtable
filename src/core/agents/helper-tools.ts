import { Type } from "typebox";
import type { AgentTurnScope } from "../domain/ports.ts";
import { THINKING_LEVELS } from "../models.ts";
import {
	optionalString,
	requiredString,
	stringList,
	type TextToolDef,
} from "../runtime/text-tools.ts";
import { CLASS, COLOR, DISPLAY, lookOf, PROMPT } from "./agent-tool-schema.ts";
import type { AgentOps } from "./agent-tools.ts";

/** The tools that make and end a knight's temp knights. */
export function helperToolDefs(
	ops: AgentOps,
	scope: AgentTurnScope,
	skillsOn: boolean,
): TextToolDef<"helper_create" | "helper_end">[] {
	return [
		{
			name: "helper_create",
			label: "Create temp knight",
			description: `Make a temp knight (a helper knight) for one self-contained task that can run on its own, such as one of several things to look up or compare. It is a real agent with its own picture and place, listed under you; it starts at once and its answer comes back to you here as a new turn, like message_agent's. Make one per task, then end your turn; when the answers are in, merge them and clear the ones that are done with helper_end. It runs your model unless you give one, cannot make knights, temp knights or groups, and has no schedules. You may have a few at once, and when you are at the limit your oldest finished one is archived to make room.`,
			parameters: Type.Object({
				display_name: DISPLAY,
				prompt: PROMPT,
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
				model: Type.Optional(
					Type.String({
						description:
							"The model to run on, as <provider>/<model>; left out, yours. An unusable one is refused with the usable list.",
					}),
				),
				thinking: Type.Optional(
					Type.Union(
						[...THINKING_LEVELS, "default"].map((level) => Type.Literal(level)),
						{ description: "Its thinking level; left out, yours." },
					),
				),
				...(skillsOn
					? {
							skills: Type.Optional(
								Type.Array(Type.String(), {
									description:
										"Skills it carries, from skill_list; pick those the task needs.",
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
				return ops.helperCreate(scope, {
					displayName: requiredString(i, "display_name"),
					prompt: requiredString(i, "prompt"),
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
	];
}
