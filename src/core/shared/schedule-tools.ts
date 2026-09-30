import { type TSchema, Type } from "typebox";
import { messages } from "../i18n/index.ts";
import { timeZone } from "../time.ts";

/**
 * Schedule tools, the same for the owner agent and party roles. Each acts on the schedules of
 * the channel it runs in; the host decides the channel and speaker, never the model.
 */
export const SCHEDULE_TOOLS = [
	"schedule_create",
	"schedule_list",
	"schedule_update",
	"schedule_cancel",
] as const;
export type ScheduleToolName = (typeof SCHEDULE_TOOLS)[number];

export function isScheduleTool(value: string): value is ScheduleToolName {
	return (SCHEDULE_TOOLS as readonly string[]).includes(value);
}

const timing = () => ({
	in_minutes: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Run once this many minutes from now; use it for relative times such as in two hours.",
		}),
	),
	at: Type.Optional(
		Type.String({
			description: `Run once at this ${messages().zoneTime(timeZone())}, "YYYY-MM-DD HH:MM". Give one of in_minutes, at, or time.`,
		}),
	),
	time: Type.Optional(
		Type.String({
			description: `Repeat at this ${messages().zoneTime(timeZone())} of day, "HH:MM".`,
		}),
	),
	every_days: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 365,
			description: "With time: run every this many days (default 1, daily).",
		}),
	),
	start_date: Type.Optional(
		Type.String({
			description:
				'With every_days: the first day, "YYYY-MM-DD" (default today); later runs count from it.',
		}),
	),
	weekdays: Type.Optional(
		Type.Array(
			Type.Union(
				["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) =>
					Type.Literal(d),
				),
			),
			{
				description: "With time: run on these weekdays instead of every_days.",
			},
		),
	),
});

export interface ScheduleToolSpec {
	name: ScheduleToolName;
	label: string;
	description: string;
	parameters: TSchema;
}

export function scheduleToolSpecs(): readonly ScheduleToolSpec[] {
	return [
		{
			name: "schedule_create",
			label: "Create schedule",
			description: `Schedule a task for yourself in this channel: at the set ${messages().zoneTime(timeZone())} you are woken with the prompt and your answer is posted here. Use it for reminders, follow-ups, and recurring checks someone asks for. Write the prompt as a complete instruction to your future self, including who it is for and what to report; it runs without the current conversation in view.`,
			parameters: Type.Object({
				title: Type.String({ description: "A short name for the schedule." }),
				prompt: Type.String({
					description: "What to do when it runs, self-contained.",
				}),
				...timing(),
			}),
		},
		{
			name: "schedule_list",
			label: "List schedules",
			description: `List this channel's schedules with their next run, and the current ${messages().zoneTime(timeZone())}. Give id to read one schedule's full prompt.`,
			parameters: Type.Object({
				id: Type.Optional(Type.Integer({ description: "Schedule id." })),
			}),
		},
		{
			name: "schedule_update",
			label: "Update schedule",
			description:
				"Change one of this channel's schedules: its title, its prompt, or its timing (timing fields replace the old timing). A run can use this to keep its own prompt current, such as adding what it already reported.",
			parameters: Type.Object({
				id: Type.Integer({ description: "Schedule id." }),
				title: Type.Optional(Type.String()),
				prompt: Type.Optional(
					Type.String({ description: "The whole new prompt." }),
				),
				...timing(),
			}),
		},
		{
			name: "schedule_cancel",
			label: "Cancel schedule",
			description: "Delete one of this channel's schedules.",
			parameters: Type.Object({
				id: Type.Integer({ description: "Schedule id." }),
			}),
		},
	];
}
