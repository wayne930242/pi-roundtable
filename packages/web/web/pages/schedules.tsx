import { useState } from "react";
import type { ScheduleView } from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Icon } from "../components/icons.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { when } from "../lib/format.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";
import { useFetched } from "../lib/use-fetched.ts";

const WEEKDAYS: Record<string, string> = {
	mon: wording("Mon"),
	tue: wording("Tue"),
	wed: wording("Wed"),
	thu: wording("Thu"),
	fri: wording("Fri"),
	sat: wording("Sat"),
	sun: wording("Sun"),
};

/** The recurrence the core stores, in words. */
export function describeRecurrence(recurrence: unknown): string {
	if (typeof recurrence !== "object" || recurrence === null) return "";
	const r = recurrence as Record<string, unknown>;
	const time = typeof r.time === "string" ? r.time : "";
	switch (r.kind) {
		case "once":
			return t("Once on {date} at {time}", {
				date: String(r.date ?? ""),
				time,
			});
		case "every":
			return Number(r.everyDays) === 1
				? t("Every day at {time}", { time })
				: t("Every {count} days at {time}", {
						count: Number(r.everyDays),
						time,
					});
		case "weekly": {
			const days = Array.isArray(r.weekdays)
				? r.weekdays
						.map((day) => t(WEEKDAYS[String(day)] ?? String(day)))
						.join(t(", "))
				: "";
			return t("{days} at {time}", { days, time });
		}
		default:
			return "";
	}
}

/** What is scheduled to run by itself, with a way to cancel each. */
export function SchedulesPage() {
	const { timeZone } = useConfig();
	const [revision, setRevision] = useState(0);
	const [cancelling, setCancelling] = useState<ScheduleView>();
	const { data, error } = useFetched(
		() => api.schedules(),
		`schedules:${revision}`,
	);
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Schedules")}</h1>
			</header>
			{error ? <Failure message={error} /> : null}
			{!data && !error ? <Loading /> : null}
			{data && data.schedules.length === 0 ? (
				<Empty>
					{t(
						"Nothing is scheduled. Ask an agent to remind you or to run something later.",
					)}
				</Empty>
			) : null}
			<ul className="schedule-list">
				{data?.schedules.map((schedule) => (
					<li key={schedule.id} className="card schedule">
						<div className="schedule-main">
							<div className="card-head">
								<strong>{schedule.title}</strong>
								{schedule.lastStatus ? (
									<Badge>{schedule.lastStatus}</Badge>
								) : null}
							</div>
							<p className="meta">
								{describeRecurrence(schedule.recurrence)} ·{" "}
								{t("next {when}", { when: when(schedule.nextRun, timeZone) })}
							</p>
							<p className="schedule-prompt">{schedule.prompt}</p>
							<p className="meta">
								{schedule.room ? (
									<a href={hrefFor("room", schedule.room)}>{schedule.label}</a>
								) : (
									schedule.label
								)}{" "}
								· {t("set by {name}", { name: schedule.createdBy })}
							</p>
						</div>
						<button
							type="button"
							className="icon-button danger-icon"
							aria-label={t("Cancel {title}", { title: schedule.title })}
							onClick={() => setCancelling(schedule)}
						>
							<Icon name="trash" />
						</button>
					</li>
				))}
			</ul>
			<Confirm
				open={cancelling !== undefined}
				title={t("Cancel this schedule?")}
				confirmLabel={t("Cancel schedule")}
				tone="danger"
				onClose={() => setCancelling(undefined)}
				onConfirm={async () => {
					if (!cancelling) return;
					await api.cancelSchedule(cancelling.id);
					setRevision((value) => value + 1);
					toast(t("Schedule cancelled."));
				}}
			>
				<p>
					{t(
						"“{title}” will not run again. Runs that already happened stay in the conversation.",
						{
							title: cancelling?.title ?? "",
						},
					)}
				</p>
			</Confirm>
		</div>
	);
}
