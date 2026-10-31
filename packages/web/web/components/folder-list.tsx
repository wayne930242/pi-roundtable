import { type ReactNode, useEffect } from "react";
import { useSelector } from "../lib/app-store.ts";
import { pruneCollapsed, useCollapsed } from "../lib/folds.ts";
import { waitingCards } from "../lib/rooms.ts";
import { type FolderSection, muteState } from "../lib/sections.ts";
import { useStaying } from "../lib/staying.ts";
import { Typing, WaitingBadge } from "../pages/rooms.tsx";
import { FolderBlock } from "./folder-header.tsx";
import { RoomPicture } from "./room-picture.tsx";

/** How many pictures a folded folder shows before it says how many more rooms it holds. */
const STACKED = 4;

/** A folded folder's rooms as a small overlapping stack of their pictures, then how many more. */
function FolderStack(props: { rooms: string[] }) {
	const shown = props.rooms.slice(0, STACKED);
	const views = useSelector(
		(state) => shown.map((key) => state.rooms[key]?.view),
		shown.join(","),
	);
	const more = props.rooms.length - shown.length;
	return (
		<span className="folder-stack" aria-hidden="true">
			{views.map((view) =>
				view ? (
					<span key={view.key} className="folder-stack-item">
						<RoomPicture view={view} size={28} />
					</span>
				) : null,
			)}
			{more > 0 ? <span className="folder-stack-more">+{more}</span> : null}
		</span>
	);
}

/** What waits or works in the rooms a fold hides, so the fold hides nothing that needs the owner. */
function FolderSummary(props: { rooms: string[] }) {
	const summary = useSelector(
		(state) => ({
			waiting: props.rooms.reduce(
				(sum, key) => sum + waitingCards(state, key),
				0,
			),
			typing: props.rooms.some((key) => state.rooms[key]?.typing),
		}),
		props.rooms.join(","),
	);
	return (
		<>
			{summary.typing ? <Typing /> : null}
			{summary.waiting ? <WaitingBadge count={summary.waiting} /> : null}
		</>
	);
}

/** The mute of a folder's rooms: none, some or all. */
function useFolderMute(rooms: string[]) {
	return useSelector(
		(state) =>
			muteState(rooms, (key) => state.rooms[key]?.view?.muted === true),
		rooms.join(","),
	);
}

/** The owners' folders of the room list, in their order; `rooms` draws the rows of one folder. */
export function FolderList(props: {
	folders: FolderSection[];
	active: string | undefined;
	listed: boolean;
	rooms(keys: string[]): ReactNode;
}) {
	const ids = props.folders.map((folder) => folder.id).join(",");
	// A fold kept for a folder that was deleted meanwhile (on another device) is forgotten.
	useEffect(() => {
		if (props.listed) pruneCollapsed(ids ? ids.split(",") : []);
	}, [props.listed, ids]);
	return (
		<>
			{props.folders.map((folder) => (
				<FolderRoomsBlock key={folder.id} folder={folder} {...props} />
			))}
		</>
	);
}

function FolderRoomsBlock(props: {
	folder: FolderSection;
	active: string | undefined;
	rooms(keys: string[]): ReactNode;
}) {
	const { folder } = props;
	const muted = useFolderMute(folder.rooms);
	const folded = useCollapsed().has(folder.id);
	// A folded folder keeps the open room and the rooms that need the owner under its heading; the
	// stack and the summary speak for the others.
	const staying = useStaying(folder.rooms, props.active);
	const shown = folded ? staying : folder.rooms;
	const hidden = folded
		? folder.rooms.filter((key) => !staying.includes(key))
		: [];
	return (
		<FolderBlock
			id={folder.id}
			name={folder.name}
			count={folder.rooms.length}
			folded={folded}
			shown={shown.length}
			muted={muted}
			summary={<FolderSummary rooms={hidden} />}
			stack={hidden.length > 0 ? <FolderStack rooms={hidden} /> : null}
		>
			{props.rooms(shown)}
		</FolderBlock>
	);
}
