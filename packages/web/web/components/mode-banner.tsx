import { useState } from "react";
import type { RoomMode } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import { changeMode } from "../lib/modes.ts";
import { Icon } from "./icons.tsx";

/**
 * The strip that stays at the top of a room while yolo or long-running mode is on, so the person
 * is never unsure why a card did not come. Each line has its own way out.
 */
export function ModeBanner(props: {
	room: string;
	mode: RoomMode | undefined;
	approved: number;
}) {
	const { mode } = props;
	const [busy, setBusy] = useState<"yolo" | "longRunning">();
	const turnOff = async (which: "yolo" | "longRunning") => {
		setBusy(which);
		await changeMode(props.room, { [which]: false });
		setBusy(undefined);
	};
	return (
		<div className="mode-banner" data-open={Boolean(mode)}>
			<div className="mode-banner-inner">
				<div className="mode-lines">
					{mode?.yolo ? (
						<div
							className="mode-line"
							data-mode="yolo"
							title={t(
								"Yolo mode is on: held actions are approved without asking.",
							)}
						>
							<Icon name="bolt" size={16} />
							<span>
								{t("Yolo mode on")}
								{props.approved > 0
									? ` · ${t("{count} approved", { count: props.approved })}`
									: ""}
							</span>
							<button
								type="button"
								className="link-button"
								disabled={busy === "yolo"}
								onClick={() => turnOff("yolo")}
							>
								{t("Turn off")}
							</button>
						</div>
					) : null}
					{mode?.longRunning ? (
						<div
							className="mode-line"
							data-mode="long"
							title={t(
								"Long-running mode is on: turns go on past their time limit.",
							)}
						>
							<Icon name="timer" size={16} />
							<span>{t("Long-running on")}</span>
							<button
								type="button"
								className="link-button"
								disabled={busy === "longRunning"}
								onClick={() => turnOff("longRunning")}
							>
								{t("Turn off")}
							</button>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
