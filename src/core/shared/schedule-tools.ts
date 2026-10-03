import { type TSchema, Type } from "typebox";
import { catalogFor, type Locale } from "../i18n/index.ts";

/**
 * Schedule tools, shared by conversation sessions. Each acts on the schedules of
 * the channel it runs in; the host decides the channel and speaker, never the model.
 */
export const SCHEDULE_TOOLS = Object.freeze([
	"schedule_create",
	"schedule_list",
	"schedule_update",
	"schedule_cancel",
] as const);
export type ScheduleToolName = (typeof SCHEDULE_TOOLS)[number];

export function isScheduleTool(value: string): value is ScheduleToolName {
	return (SCHEDULE_TOOLS as readonly string[]).includes(value);
}

const timing = (zone: string) => ({
	in_minutes: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Run once this many minutes from now; use it for relative times such as in two hours.",
		}),
	),
	at: Type.Optional(
		Type.String({
			description: `Run once at this ${zone}, "YYYY-MM-DD HH:MM". Give one of in_minutes, at, or time.`,
		}),
	),
	time: Type.Optional(
		Type.String({
			description: `Repeat at this ${zone} of day, "HH:MM".`,
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

/** The wording of the tools' descriptions: a locale's catalog, and the zone the times are in. */
export interface ScheduleToolWording {
	locale: Locale;
	/** An IANA time zone, such as `Asia/Taipei`. */
	timeZone: string;
	/**
	 * Whether the host runs agents' precheck scripts, so schedule_create and schedule_update take
	 * `precheck_script`; without it they neither take nor mention one.
	 */
	precheckScripts?: boolean;
}

export function scheduleToolSpecs(
	wording: ScheduleToolWording,
): readonly ScheduleToolSpec[] {
	const zone = catalogFor(wording.locale).zoneTime(wording.timeZone);
	const script = (cleared: boolean): Record<string, TSchema> =>
		wording.precheckScripts
			? {
					precheck_script: Type.Optional(
						cleared
							? Type.Union([Type.String(), Type.Null()], {
									description:
										"A JavaScript module the host runs in a sandbox before each turn, as schedule_list explains; it replaces precheck. null removes it.",
								})
							: Type.String({
									description:
										"A JavaScript module the host runs in a sandbox before each turn, as schedule_list explains; instead of precheck.",
								}),
					),
				}
			: {};
	return [
		{
			name: "schedule_create",
			label: "Create schedule",
			description: `Schedule a task for yourself in this channel: at the set ${zone} you are woken with the prompt and your answer is posted here. Use it for reminders, follow-ups, and recurring checks someone asks for. Write the prompt as a complete instruction to your future self, including who it is for and what to report; it runs without the current conversation in view.`,
			parameters: Type.Object({
				title: Type.String({ description: "A short name for the schedule." }),
				prompt: Type.String({
					description: "What to do when it runs, self-contained.",
				}),
				...timing(zone),
				precheck: Type.Optional(
					Type.String({
						description:
							"The name of a precheck the host runs first, from schedule_list; you are woken only when it finds something.",
					}),
				),
				...script(false),
			}),
		},
		{
			name: "schedule_list",
			label: "List schedules",
			description: `List this channel's schedules with their next run, and the current ${zone}, and the prechecks a schedule may attach. Give id to read one schedule's full prompt.`,
			parameters: Type.Object({
				id: Type.Optional(Type.Integer({ description: "Schedule id." })),
			}),
		},
		{
			name: "schedule_update",
			label: "Update schedule",
			description:
				"Change one of this channel's schedules: its title, its prompt, its timing (timing fields replace the old timing), or its precheck. A run can use this to keep its own prompt current, such as adding what it already reported.",
			parameters: Type.Object({
				id: Type.Integer({ description: "Schedule id." }),
				title: Type.Optional(Type.String()),
				prompt: Type.Optional(
					Type.String({ description: "The whole new prompt." }),
				),
				...timing(zone),
				precheck: Type.Optional(
					Type.Union([Type.String(), Type.Null()], {
						description:
							"A precheck's name from schedule_list to run first, or null to remove the schedule's precheck.",
					}),
				),
				...script(true),
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
