import { messages } from "../../i18n/index.ts";
import { timeZone, zonedStamp } from "../../time.ts";
import type { PrecheckFinding } from "./prechecks.ts";
import { describeRecurrence } from "./recurrence.ts";
import type { Schedule } from "./schedule-store.ts";

/** What the schedule's precheck found, or how it failed, under its own heading after the task. */
function findingText(finding: PrecheckFinding): string[] {
	return "error" in finding
		? [
				"",
				`### Precheck failed: ${finding.precheck}`,
				`The precheck that decides whether this task needs you failed, so you were woken anyway: ${finding.error}. Check what it watches yourself, and say so if it needs fixing.`,
			]
		: ["", `### Precheck found (${finding.precheck}):`, finding.context];
}

/** What a scheduled run receives as its message, with what its precheck found when it has one. */
export function scheduledTurnText(
	schedule: Schedule,
	firedAt: Date,
	finding?: PrecheckFinding,
): string {
	return [
		`## Scheduled task #${schedule.id}: ${schedule.title}`,
		`${schedule.createdByName} set this schedule (${describeRecurrence(schedule.recurrence)}). It is due now, ${zonedStamp(firedAt)} ${messages().zoneTime(timeZone())}. Nobody wrote a new message: carry out the task below and write what you would post in this channel. If the task keeps a record for later runs, update it with schedule_update on #${schedule.id}.`,
		"",
		schedule.prompt,
		...(finding ? findingText(finding) : []),
	].join("\n");
}
