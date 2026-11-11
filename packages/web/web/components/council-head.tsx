import type { RefObject } from "react";
import type { RoomView } from "../../src/api-types.ts";
import type { CouncilMode } from "../lib/council-mode.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { openTeamSheet } from "../lib/team-sheet.ts";
import { HeaderPicture } from "./header-picture.tsx";
import { Icon } from "./icons.tsx";
import { RoomPicture } from "./room-picture.tsx";
import { Segmented } from "./segmented.tsx";
import { WaitingButton } from "./waiting-button.tsx";

/** The switch between the scene with its dialogue box and the council's messages as a chat. */
function ModeSwitch(props: {
	mode: CouncilMode;
	onMode(mode: CouncilMode): void;
}) {
	const option = (
		mode: CouncilMode,
		label: string,
		icon: "table" | "rooms",
	) => ({
		value: mode,
		title: label,
		label: (
			<>
				<Icon name={icon} size={16} />
				<span className="mode-label">{label}</span>
			</>
		),
	});
	return (
		<Segmented
			className="table-mode"
			legend={t("Show the council as")}
			name="table-mode"
			value={props.mode}
			options={[
				option("scene", t("Animation mode"), "table"),
				option("chat", t("Chat mode"), "rooms"),
			]}
			onChange={props.onMode}
		/>
	);
}

/**
 * The one header of a council, on the round table and in the group's room: its picture, its name
 * with a line under it, then the reset button where the scene has one, the switch between the
 * scene and the chat, the waiting cards and the room menu. In the room the name opens the group's
 * editor, a way back and the room drawer come with the picture; on the round table the name is the
 * council picker. On a phone it is one row: the switch shows icons, its words stay for a screen
 * reader and as the tooltip.
 */
export function CouncilHead(props: {
	view: RoomView | undefined;
	name: string;
	working: boolean;
	/** The group's room: a way back, the room drawer behind the picture, and a name that edits the group. Absent on the round table. */
	room?: { drawer: (() => void) | undefined } | undefined;
	/** The round table's name opens this, the sheet where another council is picked or this one edited. */
	onPick(): void;
	/** Brings the camera back to the whole ring; absent when the scene has no camera to bring back. */
	onReset: (() => void) | undefined;
	/** The scene/chat switch; absent when no one sits. */
	mode: CouncilMode | undefined;
	onMode(mode: CouncilMode): void;
	menuButton: RefObject<HTMLButtonElement | null>;
	onMenu(): void;
}) {
	const { view, name, room } = props;
	const group = view?.kind === "group" ? view.name : undefined;
	const picture = view ? <RoomPicture view={view} size={36} /> : null;
	return (
		<header className="room-head council-head">
			{room ? (
				<a
					className="icon-button room-back"
					href={hrefFor("rooms")}
					aria-label={t("Back to rooms")}
				>
					<Icon name="back" />
				</a>
			) : null}
			{picture ? (
				<HeaderPicture open={room?.drawer}>{picture}</HeaderPicture>
			) : null}
			<div className="room-title">
				<h1>
					{room ? (
						group ? (
							<button
								type="button"
								className="room-name"
								aria-haspopup="dialog"
								title={t("Edit group")}
								onClick={() => openTeamSheet({ kind: "group", name: group })}
							>
								{name}
							</button>
						) : (
							name
						)
					) : (
						<button
							type="button"
							className="room-name council-pick"
							aria-haspopup="dialog"
							title={t("Switch council")}
							onClick={props.onPick}
						>
							{name}
							<span aria-hidden="true"> ▾</span>
						</button>
					)}
					{view?.muted ? (
						<Icon
							name="bell-off"
							size={14}
							className="room-muted"
							role="img"
							aria-hidden={false}
							aria-label={t("Notifications are off")}
						/>
					) : null}
				</h1>
				<span className="room-status" data-working={props.working || undefined}>
					{view?.readOnly
						? t("Read-only")
						: props.working
							? t("Working…")
							: t("Group")}
				</span>
			</div>
			<div className="table-tools">
				{props.onReset ? (
					<button
						type="button"
						className="icon-button"
						aria-label={t("Reset view")}
						title={t("Reset view")}
						onClick={props.onReset}
					>
						<Icon name="reset" />
					</button>
				) : null}
				{props.mode ? (
					<ModeSwitch mode={props.mode} onMode={props.onMode} />
				) : null}
			</div>
			<WaitingButton />
			<button
				ref={props.menuButton}
				type="button"
				className="icon-button"
				aria-label={t("Room menu")}
				aria-haspopup="dialog"
				onClick={props.onMenu}
			>
				<Icon name="menu" />
			</button>
		</header>
	);
}
