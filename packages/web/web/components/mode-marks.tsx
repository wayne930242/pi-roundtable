import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

/** A room's Yolo and long-running modes as two small marks, for the rows that list rooms. */
export function ModeMarks(props: {
	yolo: boolean;
	longRunning: boolean;
	size?: number;
}) {
	const size = props.size ?? 14;
	return (
		<>
			{props.yolo ? (
				<span
					className="mode-mark"
					data-mode="yolo"
					title={t("Yolo")}
					role="img"
					aria-label={t("Yolo")}
				>
					<Icon name="bolt" size={size} />
				</span>
			) : null}
			{props.longRunning ? (
				<span
					className="mode-mark"
					data-mode="long"
					title={t("Long-running")}
					role="img"
					aria-label={t("Long-running")}
				>
					<Icon name="timer" size={size} />
				</span>
			) : null}
		</>
	);
}
