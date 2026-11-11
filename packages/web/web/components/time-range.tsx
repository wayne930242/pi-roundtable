import {
	type FieldLook,
	installFieldStyle,
	lookAttributes,
} from "../lib/field-look.ts";
import { translate as t } from "../lib/messages.ts";
import { Select } from "./fields.tsx";

/** Every half hour of the day, `00:00` to `23:30`. */
export const HALF_HOURS: readonly string[] = Array.from(
	{ length: 48 },
	(_, index) =>
		`${String(index >> 1).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}`,
);

/** The times a drop-down offers: the half hours, and `chosen` in its place among them when it is not one. */
export function timeOptions(chosen: string): readonly string[] {
	return HALF_HOURS.includes(chosen)
		? HALF_HOURS
		: [...HALF_HOURS, chosen].sort();
}

/**
 * A span of the day as two drop-downs, From and To, of `HH:MM` times on a 24-hour clock in
 * half-hour steps. A time that is not a half hour (22:10, saved before the list) is offered as it
 * is and stays chosen until the person picks another. `zone` is the time zone the times are read
 * in, shown after the drop-downs and level with them. The look is the two drop-downs'.
 */
export function TimeRange(
	props: {
		start: string;
		end: string;
		onChange(next: { start: string; end: string }): void;
		zone?: string;
	} & FieldLook,
) {
	installFieldStyle();
	const { start, end, size, tone, variant } = props;
	const look = { size, tone, variant };
	const times = (chosen: string) =>
		timeOptions(chosen).map((time) => (
			<option key={time} value={time}>
				{time}
			</option>
		));
	return (
		<div className="time-range" data-size={lookAttributes(look)["data-size"]}>
			<label>
				{t("From")}
				<Select
					{...look}
					value={start}
					onChange={(event) =>
						props.onChange({ start: event.target.value, end })
					}
				>
					{times(start)}
				</Select>
			</label>
			<label>
				{t("To")}
				<Select
					{...look}
					value={end}
					onChange={(event) =>
						props.onChange({ start, end: event.target.value })
					}
				>
					{times(end)}
				</Select>
			</label>
			{props.zone ? (
				<span className="meta time-range-zone">{props.zone}</span>
			) : null}
		</div>
	);
}
