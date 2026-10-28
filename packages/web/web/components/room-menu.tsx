import { useState } from "react";
import type { RoomMode } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import { changeMode } from "../lib/modes.ts";
import { hrefFor } from "../lib/router.ts";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { Switch } from "./switch.tsx";

const YOLO_ID = "room-menu-yolo";
const LONG_ID = "room-menu-long";

/** The room's menu: the two modes, the agent's profile, and starting over; a thread's only links to its parent. */
export function RoomMenu(props: {
	open: boolean;
	room: string;
	mode: RoomMode | undefined;
	/** The agent whose profile to link; absent for a group. */
	agent?: string | undefined;
	/** A thread's room: it has no modes and cannot be started over. */
	readOnly?: boolean;
	/** The room a thread belongs to. */
	parent?: string | undefined;
	onClose(): void;
	onAskYolo(): void;
	onAskStartOver(): void;
}) {
	const [busy, setBusy] = useState(false);
	const mode = props.mode ?? { yolo: false, longRunning: false };
	const setLong = async (next: boolean) => {
		setBusy(true);
		await changeMode(props.room, { longRunning: next });
		setBusy(false);
	};
	return (
		<Sheet open={props.open} title={t("Room menu")} onClose={props.onClose}>
			<ul className="menu">
				{props.readOnly ? (
					<li>
						{props.parent ? (
							<a
								className="menu-item menu-link"
								href={hrefFor("room", props.parent)}
								onClick={props.onClose}
							>
								<span className="menu-icon">
									<Icon name="rooms" />
								</span>
								<span className="menu-text">
									<strong>{t("Open the parent room")}</strong>
									<span className="meta">
										{t("Reply to the agent that started this thread.")}
									</span>
								</span>
								<Icon name="chevron" size={16} />
							</a>
						) : (
							<p className="meta">{t("A thread has no settings.")}</p>
						)}
					</li>
				) : null}
				{props.readOnly ? null : (
					<li>
						<label className="menu-item menu-toggle" htmlFor={YOLO_ID}>
							<span className="menu-icon" data-tone="yolo">
								<Icon name="bolt" />
							</span>
							<span className="menu-text">
								<strong>{t("Yolo mode")}</strong>
								<span className="meta">
									{t(
										"Approve held actions in this room without asking. Risky ones still ask.",
									)}
								</span>
							</span>
							<Switch
								id={YOLO_ID}
								checked={mode.yolo}
								label={t("Yolo mode")}
								onChange={(next) => {
									if (next) props.onAskYolo();
									else {
										setBusy(true);
										changeMode(props.room, { yolo: false }).then(() =>
											setBusy(false),
										);
									}
								}}
								busy={busy}
							/>
						</label>
					</li>
				)}
				{props.readOnly ? null : (
					<li>
						<label className="menu-item menu-toggle" htmlFor={LONG_ID}>
							<span className="menu-icon" data-tone="long">
								<Icon name="timer" />
							</span>
							<span className="menu-text">
								<strong>{t("Long-running mode")}</strong>
								<span className="meta">
									{t(
										"Let turns go on past their time limit, up to the host's cap. Questions still wait for you.",
									)}
								</span>
							</span>
							<Switch
								id={LONG_ID}
								checked={mode.longRunning}
								label={t("Long-running mode")}
								onChange={setLong}
								busy={busy}
							/>
						</label>
					</li>
				)}
				{props.agent ? (
					<li>
						<a
							className="menu-item menu-link"
							href={hrefFor("agent", props.agent)}
							onClick={props.onClose}
						>
							<span className="menu-icon">
								<Icon name="profile" />
							</span>
							<span className="menu-text">
								<strong>{t("Profile")}</strong>
								<span className="meta">
									{t("Name, prompt, model and picture")}
								</span>
							</span>
							<Icon name="chevron" size={16} />
						</a>
					</li>
				) : null}
				{props.readOnly ? null : (
					<li>
						<button
							type="button"
							className="menu-item menu-link"
							onClick={props.onAskStartOver}
						>
							<span className="menu-icon" data-tone="danger">
								<Icon name="reset" />
							</span>
							<span className="menu-text">
								<strong>{t("Start over")}</strong>
								<span className="meta">
									{t(
										"Archive this conversation and begin a new one. Memory stays.",
									)}
								</span>
							</span>
						</button>
					</li>
				)}
			</ul>
		</Sheet>
	);
}
