import { useState } from "react";
import type { RoomMode } from "../../src/api-types.ts";
import { api, messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { Switch } from "./switch.tsx";

/** The room's menu: the two modes, the agent's profile, and starting over. */
export function RoomMenu(props: {
	open: boolean;
	room: string;
	mode: RoomMode | undefined;
	/** The agent whose profile to link; absent for a group. */
	agent?: string | undefined;
	onClose(): void;
	onAskYolo(): void;
	onAskStartOver(): void;
}) {
	const [busy, setBusy] = useState(false);
	const mode = props.mode ?? { yolo: false, longRunning: false };
	const setLong = async (next: boolean) => {
		setBusy(true);
		try {
			await api.setMode(props.room, { longRunning: next });
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			setBusy(false);
		}
	};
	return (
		<Sheet open={props.open} title={t("Room menu")} onClose={props.onClose}>
			<ul className="menu">
				<li className="menu-item">
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
						checked={mode.yolo}
						label={t("Yolo mode")}
						onChange={(next) => {
							if (next) props.onAskYolo();
							else {
								setBusy(true);
								api
									.setMode(props.room, { yolo: false })
									.catch((failure) => toast(messageOf(failure), "danger"))
									.finally(() => setBusy(false));
							}
						}}
						busy={busy}
					/>
				</li>
				<li className="menu-item">
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
						checked={mode.longRunning}
						label={t("Long-running mode")}
						onChange={setLong}
						busy={busy}
					/>
				</li>
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
			</ul>
		</Sheet>
	);
}
