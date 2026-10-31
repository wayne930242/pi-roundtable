import { useState } from "react";
import type { RoomMode } from "../../src/api-types.ts";
import { openAgentSheet } from "../lib/agent-sheet.ts";
import { useSelector } from "../lib/app-store.ts";
import { askFolderDialog } from "../lib/folder-dialogs.ts";
import "../lib/layout-icons.ts";
import { useConfig } from "../lib/config.ts";
import { translate as t } from "../lib/messages.ts";
import { changeMode } from "../lib/modes.ts";
import { setRoomMuted } from "../lib/mute.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { hrefFor } from "../lib/router.ts";
import { openTeamSheet } from "../lib/team-sheet.ts";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { Switch } from "./switch.tsx";

const YOLO_ID = "room-menu-yolo";
const LONG_ID = "room-menu-long";
const MUTE_ID = "room-menu-mute";

/** The room's menu: the push, the two modes, the agent's sheet, pinning and filing the room, and starting over; a thread's only links to its parent. */
export function RoomMenu(props: {
	open: boolean;
	room: string;
	mode: RoomMode | undefined;
	/** The owners muted this room's push. */
	muted?: boolean;
	/** The agent whose profile to link; absent for a group. */
	agent?: string | undefined;
	/** The group whose members and host to edit; absent for an agent. */
	group?: string | undefined;
	/** The coordinator's room: the team's entry, which cannot be archived. */
	coordinator?: boolean;
	/** What the room is called, for the question before it is archived. */
	displayName?: string;
	/** A thread's room: it has no modes and cannot be started over. */
	readOnly?: boolean;
	/** The room a thread belongs to. */
	parent?: string | undefined;
	onClose(): void;
	onAskYolo(): void;
	onAskStartOver(): void;
}) {
	const [busy, setBusy] = useState(false);
	// A host can leave the two switches out.
	const switches = useConfig().app?.modes !== false;
	// Home stays at the top; every other room can be pinned or put in a folder.
	const placeable = useSelector(
		(state) => state.rooms[props.room]?.view?.home === false,
		props.room,
	);
	const pinned = useSelector(
		(state) => state.pins.includes(props.room),
		props.room,
	);
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
										{t("Reply to the knight that started this thread.")}
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
						<label className="menu-item menu-toggle" htmlFor={MUTE_ID}>
							<span className="menu-icon">
								<Icon name={props.muted ? "bell-off" : "bell"} />
							</span>
							<span className="menu-text">
								<strong>{t("Notifications")}</strong>
								<span className="meta">
									{t(
										"Push this room's posts to every owner's devices. A card that waits for you is always pushed.",
									)}
								</span>
							</span>
							<Switch
								id={MUTE_ID}
								checked={!props.muted}
								label={t("Notifications")}
								onChange={async (next) => {
									setBusy(true);
									await setRoomMuted(props.room, !next);
									setBusy(false);
								}}
								busy={busy}
							/>
						</label>
					</li>
				)}
				{props.readOnly || !switches ? null : (
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
				{props.readOnly || !switches ? null : (
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
						<button
							type="button"
							className="menu-item menu-link"
							aria-haspopup="dialog"
							onClick={() => {
								props.onClose();
								openAgentSheet(props.agent as string);
							}}
						>
							<span className="menu-icon">
								<Icon name="profile" />
							</span>
							<span className="menu-text">
								<strong>{t("Edit knight")}</strong>
								<span className="meta">
									{t("Name, prompt, model and picture")}
								</span>
							</span>
							<Icon name="chevron" size={16} />
						</button>
					</li>
				) : null}
				{props.agent ? (
					<li>
						<button
							type="button"
							className="menu-item menu-link"
							aria-haspopup="dialog"
							onClick={() => {
								props.onClose();
								openAgentSheet(props.agent as string, { skills: true });
							}}
						>
							<span className="menu-icon">
								<Icon name="skills" />
							</span>
							<span className="menu-text">
								<strong>{t("Skills")}</strong>
								<span className="meta">
									{t("Choose the skills this knight carries.")}
								</span>
							</span>
							<Icon name="chevron" size={16} />
						</button>
					</li>
				) : null}
				{props.group ? (
					<li>
						<button
							type="button"
							className="menu-item menu-link"
							aria-haspopup="dialog"
							onClick={() => {
								props.onClose();
								openTeamSheet({ kind: "group", name: props.group as string });
							}}
						>
							<span className="menu-icon">
								<Icon name="profile" />
							</span>
							<span className="menu-text">
								<strong>{t("Edit group")}</strong>
								<span className="meta">{t("Name, members and host")}</span>
							</span>
							<Icon name="chevron" size={16} />
						</button>
					</li>
				) : null}
				{props.readOnly || !placeable ? null : (
					<>
						<li>
							<button
								type="button"
								className="menu-item menu-link"
								onClick={() => {
									props.onClose();
									void import("../lib/layout-actions.ts").then((one) =>
										one.pinRoom(props.room, !pinned),
									);
								}}
							>
								<span className="menu-icon">
									<Icon name="pin" />
								</span>
								<span className="menu-text">
									<strong>{pinned ? t("Unpin") : t("Pin")}</strong>
									<span className="meta">
										{t("Keep this room at the top of the list.")}
									</span>
								</span>
							</button>
						</li>
						<li>
							<button
								type="button"
								className="menu-item menu-link"
								aria-haspopup="dialog"
								onClick={() => {
									props.onClose();
									askFolderDialog({ kind: "move", room: props.room });
								}}
							>
								<span className="menu-icon">
									<Icon name="folder" />
								</span>
								<span className="menu-text">
									<strong>{t("Move to folder…")}</strong>
									<span className="meta">
										{t("Put this room in a folder, or take it out.")}
									</span>
								</span>
								<Icon name="chevron" size={16} />
							</button>
						</li>
					</>
				)}
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
				{props.readOnly || props.coordinator ? null : (
					<li>
						<button
							type="button"
							className="menu-item menu-link"
							onClick={() => {
								props.onClose();
								askRoomConfirm({
									kind: "archive",
									room: props.room,
									name: props.displayName ?? "",
								});
							}}
						>
							<span className="menu-icon" data-tone="danger">
								<Icon name="archive" />
							</span>
							<span className="menu-text">
								<strong>
									{props.group ? t("Archive group") : t("Archive knight")}
								</strong>
								<span className="meta">
									{t(
										"It stops answering. The history is kept and it can be restored.",
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
