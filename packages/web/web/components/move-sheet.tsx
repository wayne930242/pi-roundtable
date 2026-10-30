import "../lib/layout-icons.ts";
import { nudgeBefore } from "../../src/layout-order.ts";
import { useSelector } from "../lib/app-store.ts";
import { askFolderDialog } from "../lib/folder-dialogs.ts";
import { moveRoom, nudgeRoom } from "../lib/layout-actions.ts";
import { translate as t } from "../lib/messages.ts";
import { activityAt } from "../lib/rooms.ts";
import { placeOf, sections } from "../lib/sections.ts";
import { Dialog } from "./dialog.tsx";
import { Icon } from "./icons.tsx";

function Body(props: { room: string; onClose(): void }) {
	const { room } = props;
	// Only numbers, text and flags are picked, so the sheet redraws when the room's place changes.
	const where = useSelector((state) => {
		const arrangement = sections(state, (key) => activityAt(state, key));
		const place = placeOf(arrangement, room);
		const siblings = place.kind === "rest" ? [] : place.siblings;
		return {
			name: state.rooms[room]?.view?.displayName ?? room,
			folder: place.kind === "folder" ? place.folder : "",
			pinned: place.kind === "pinned",
			canUp: nudgeBefore(siblings, room, "up") !== undefined,
			canDown: nudgeBefore(siblings, room, "down") !== undefined,
		};
	}, room);
	const folders = useSelector((state) => state.folders);
	const choose = (folder: string | null) => {
		props.onClose();
		void moveRoom(room, folder);
	};
	const loose = where.folder === "" && !where.pinned;
	return (
		<div className="stack">
			<p className="meta">{where.name}</p>
			<fieldset>
				<legend className="visually-hidden">{t("Move to folder…")}</legend>
				<ul className="menu">
					<li>
						<label className="menu-item menu-link">
							<input
								type="radio"
								name="move-folder"
								checked={loose}
								onChange={() => choose(null)}
							/>
							<span className="menu-icon">
								<Icon name="rooms" size={18} />
							</span>
							<span className="menu-text">
								<strong>{t("Ungrouped")}</strong>
							</span>
						</label>
					</li>
					{folders.map((folder) => (
						<li key={folder.id}>
							<label className="menu-item menu-link">
								<input
									type="radio"
									name="move-folder"
									checked={where.folder === folder.id}
									onChange={() => choose(folder.id)}
								/>
								<span className="menu-icon">
									<Icon name="folder" size={18} />
								</span>
								<span className="menu-text">
									<strong>{folder.name}</strong>
								</span>
							</label>
						</li>
					))}
					<li>
						<button
							type="button"
							className="menu-item menu-link"
							onClick={() => askFolderDialog({ kind: "new", room })}
						>
							<span className="menu-icon">
								<Icon name="plus" size={18} />
							</span>
							<span className="menu-text">
								<strong>{t("New folder…")}</strong>
							</span>
						</button>
					</li>
				</ul>
			</fieldset>
			{where.canUp || where.canDown ? (
				<ul className="menu">
					{where.canUp ? (
						<li>
							<button
								type="button"
								className="menu-item menu-link"
								onClick={() => {
									props.onClose();
									void nudgeRoom(room, "up");
								}}
							>
								<span className="menu-icon">
									<Icon name="up" size={18} />
								</span>
								<span className="menu-text">
									<strong>{t("Move up")}</strong>
								</span>
							</button>
						</li>
					) : null}
					{where.canDown ? (
						<li>
							<button
								type="button"
								className="menu-item menu-link"
								onClick={() => {
									props.onClose();
									void nudgeRoom(room, "down");
								}}
							>
								<span className="menu-icon">
									<Icon name="down" size={18} />
								</span>
								<span className="menu-text">
									<strong>{t("Move down")}</strong>
								</span>
							</button>
						</li>
					) : null}
				</ul>
			) : null}
		</div>
	);
}

/** Where a room goes: one of the folders, none, or a new folder; and a step up or down within its list. */
export function MoveSheet(props: {
	open: boolean;
	room: string;
	onClose(): void;
}) {
	return (
		<Dialog
			open={props.open}
			title={t("Move to folder…")}
			onClose={props.onClose}
		>
			<Body room={props.room} onClose={props.onClose} />
		</Dialog>
	);
}
