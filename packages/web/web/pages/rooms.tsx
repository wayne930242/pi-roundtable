import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { FolderBlock } from "../components/folder-header.tsx";
import { Icon } from "../components/icons.tsx";
import { RoomPicture } from "../components/room-picture.tsx";
import { Empty } from "../components/states.tsx";
import { openMenu } from "../lib/action-menu.ts";
import { useSelector } from "../lib/app-store.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { askFolderDialog } from "../lib/folder-dialogs.ts";
import { ago } from "../lib/format.ts";
import { pruneCollapsed, roomLifting } from "../lib/layout.ts";
import { useLive } from "../lib/live.ts";
import { openAddMenu, roomMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { activityAt, lastMessage, waitingCards } from "../lib/rooms.ts";
import { hrefFor } from "../lib/router.ts";
import { useRowPress } from "../lib/row-press.ts";
import {
	muteState,
	type Sections,
	sections,
	type ThreadKeys,
} from "../lib/sections.ts";

/** What a message reads as in a list, on one line. */
function previewOf(text: string, files: number): string {
	// Markdown marks would show as stray symbols in one line.
	const flat = text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(^|\s)([-*+]|\d+\.)\s/g, "$1")
		.replace(/[*_`#>~]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (flat) return flat.slice(0, 140);
	return files ? plural(files, "{count} file", "{count} files") : "";
}

interface RowData {
	key: string;
	view: RoomView;
	typing: boolean;
	yolo: boolean;
	longRunning: boolean;
	waiting: number;
	preview: string;
	at: string | undefined;
}

/** The dots that show an agent is working in the room. */
const Typing = () => (
	<span className="typing" role="img" aria-label={t("Working")}>
		<i />
		<i />
		<i />
	</span>
);

const WaitingBadge = ({ count }: { count: number }) => (
	<span className="badge badge-warn">
		{plural(count, "{count} card waiting", "{count} cards waiting")}
	</span>
);

const RoomRow = memo(function RoomRow(
	props: Omit<RowData, "key"> & {
		active: boolean;
		now: number;
		timeZone: string;
		/** The dispatch threads of this room, nested under it. */
		threads?: ReactNode;
		/** The page is in arrange mode: a menu button sits beside the row. */
		arranging?: boolean;
	},
) {
	const { view } = props;
	const accent = useAccentStyle(view.character);
	// Home stays at the top; every other row can be lifted and dropped in a pinned list, a folder or the rest.
	const press = useRowPress(
		() => roomMenuOf(view.key),
		view.home ? undefined : roomLifting(view.key),
	);
	return (
		<li {...(view.home ? {} : { "data-drop-item": "", "data-key": view.key })}>
			<a
				className="room-row"
				{...press}
				href={hrefFor("room", view.key)}
				data-home={view.home || undefined}
				aria-current={props.active ? "page" : undefined}
				style={accent}
			>
				<RoomPicture view={view} size={view.home ? 52 : 44} />
				<span className="room-row-main">
					<span className="room-row-top">
						<strong>{view.displayName}</strong>
						{view.muted ? (
							<Icon
								name="bell-off"
								size={14}
								className="muted-mark"
								role="img"
								aria-hidden={false}
								aria-label={t("Notifications are off")}
							/>
						) : null}
						{view.home ? (
							<span className="badge badge-accent">{t("Home")}</span>
						) : null}
						{view.kind === "group" ? (
							<span className="badge">{t("Group")}</span>
						) : null}
						<span className="room-row-time">
							{props.at ? ago(props.at, props.now, props.timeZone) : ""}
						</span>
					</span>
					<span className="room-row-preview">
						{props.typing ? <Typing /> : null}
						<span>{props.preview || t("No messages yet")}</span>
					</span>
					<span className="room-row-badges">
						{props.waiting ? <WaitingBadge count={props.waiting} /> : null}
						{props.yolo ? (
							<span className="badge badge-yolo">
								<Icon name="bolt" size={12} />
								{t("Yolo")}
							</span>
						) : null}
						{props.longRunning ? (
							<span className="badge badge-long">
								<Icon name="timer" size={12} />
								{t("Long-running")}
							</span>
						) : null}
					</span>
				</span>
				<Icon name="chevron" size={16} className="room-row-chevron" />
			</a>
			{props.arranging ? (
				<button
					type="button"
					className="icon-button row-more"
					aria-haspopup="menu"
					aria-label={t("Room menu")}
					onClick={(event) => {
						const button = event.currentTarget;
						roomMenuOf(view.key).then(
							(spec) => {
								if (!spec) return;
								const box = button.getBoundingClientRect();
								openMenu({
									...spec,
									at: { x: box.left, y: box.bottom },
									via: "key",
									source: button,
								});
							},
							() => undefined,
						);
					}}
				>
					<Icon name="more" size={18} />
				</button>
			) : null}
			{props.threads}
		</li>
	);
});

/** A dispatch thread under its room: one line with its title, what it is doing, and when it last said something. */
const ThreadRow = memo(function ThreadRow(
	props: Omit<RowData, "key"> & {
		active: boolean;
		now: number;
		timeZone: string;
	},
) {
	const { view } = props;
	return (
		<li>
			<a
				className="thread-row"
				href={hrefFor("room", view.key)}
				data-closed={view.closed || undefined}
				aria-current={props.active ? "page" : undefined}
			>
				<Icon name="conversations" size={16} className="thread-row-icon" />
				<span className="thread-row-title">{view.displayName}</span>
				{props.typing ? <Typing /> : null}
				{props.waiting ? <WaitingBadge count={props.waiting} /> : null}
				<span className="room-row-time">
					{props.at ? ago(props.at, props.now, props.timeZone) : ""}
				</span>
			</a>
		</li>
	);
});

/** The rows for rooms, each with what the list shows of it; rooms the list does not know are left out. */
function useRowData(keys: readonly string[]): RowData[] {
	const rows = useSelector(
		(state) =>
			keys.map((key) => {
				const room = state.rooms[key];
				const last = lastMessage(state, key);
				return {
					key,
					view: room?.view,
					typing: room?.typing ?? false,
					yolo: room?.mode.yolo ?? false,
					longRunning: room?.mode.longRunning ?? false,
					waiting: waitingCards(state, key),
					preview: last ? previewOf(last.text, last.files.length) : "",
					at: last?.at,
				};
			}),
		keys.join(","),
	);
	return rows.flatMap((row) => (row.view ? [{ ...row, view: row.view }] : []));
}

/** The threads of a room: the open ones, then the finished ones folded away until asked for. */
function ThreadList(props: {
	open: string[];
	closed: string[];
	active: string | undefined;
}) {
	const { now } = useLive();
	const { timeZone } = useConfig();
	const open = useRowData(props.open);
	const closed = useRowData(props.closed);
	if (open.length === 0 && closed.length === 0) return null;
	const row = ({ key, ...rest }: RowData) => (
		<ThreadRow
			key={key}
			{...rest}
			active={key === props.active}
			now={now}
			timeZone={timeZone}
		/>
	);
	return (
		<div className="thread-group">
			{open.length ? (
				<ul className="thread-list" aria-label={t("Dispatch threads")}>
					{open.map(row)}
				</ul>
			) : null}
			{closed.length ? (
				<details
					className="thread-closed"
					{...(closed.some((one) => one.key === props.active)
						? { open: true }
						: {})}
				>
					<summary>
						{plural(
							closed.length,
							"{count} finished thread",
							"{count} finished threads",
						)}
					</summary>
					<ul className="thread-list">{closed.map(row)}</ul>
				</details>
			) : null}
		</div>
	);
}

/** The rows of rooms, each with its dispatch threads under it. */
function RoomList(props: {
	rooms: string[];
	threads: Record<string, ThreadKeys>;
	active: string | undefined;
	arranging: boolean;
}) {
	const { now } = useLive();
	const { timeZone } = useConfig();
	const shown = useRowData(props.rooms);
	return (
		<ul className="room-list">
			{shown.map(({ key, ...row }) => {
				const threads = props.threads[key];
				return (
					<RoomRow
						key={key}
						{...row}
						active={key === props.active}
						now={now}
						timeZone={timeZone}
						arranging={props.arranging}
						{...(threads
							? {
									threads: (
										<ThreadList
											open={threads.open}
											closed={threads.closed}
											active={props.active}
										/>
									),
								}
							: {})}
					/>
				);
			})}
		</ul>
	);
}

function Section(props: {
	title: string;
	rooms: string[];
	threads: Record<string, ThreadKeys>;
	active: string | undefined;
	arranging: boolean;
	/** A place a lifted room can be dropped: the pinned list or the rest. */
	zone?: { kind: "pinned" | "rest"; id: string };
}) {
	const shown = useRowData(props.rooms);
	if (shown.length === 0) return null;
	return (
		<section
			className="stack"
			{...(props.zone
				? { "data-drop-zone": props.zone.kind, "data-zone-id": props.zone.id }
				: {})}
		>
			<h2 className="section-title">{props.title}</h2>
			<RoomList
				rooms={props.rooms}
				threads={props.threads}
				active={props.active}
				arranging={props.arranging}
			/>
		</section>
	);
}

/** What waits or works in a folded folder's rooms, so the fold hides nothing that needs the owner. */
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

function FolderRooms(props: {
	folder: Sections["folders"][number];
	threads: Record<string, ThreadKeys>;
	active: string | undefined;
	arranging: boolean;
}) {
	const { folder } = props;
	const muted = useFolderMute(folder.rooms);
	return (
		<FolderBlock
			id={folder.id}
			name={folder.name}
			count={folder.rooms.length}
			holdsActive={
				props.active !== undefined && folder.rooms.includes(props.active)
			}
			muted={muted}
			summary={<FolderSummary rooms={folder.rooms} />}
		>
			<RoomList
				rooms={folder.rooms}
				threads={props.threads}
				active={props.active}
				arranging={props.arranging}
			/>
		</FolderBlock>
	);
}

/** The page's menu: a new folder, and arrange mode, which shows each row's menu button. */
function openRoomsMenu(
	button: HTMLElement,
	arranging: boolean,
	setArranging: (next: boolean) => void,
): void {
	const box = button.getBoundingClientRect();
	openMenu({
		title: t("Rooms"),
		items: [
			{
				id: "new-folder",
				label: t("Add a folder"),
				icon: "plus",
				run: () => askFolderDialog({ kind: "new" }),
			},
			{
				id: "arrange",
				label: arranging ? t("Done") : t("Arrange"),
				icon: arranging ? "check" : "list",
				run: () => setArranging(!arranging),
			},
		],
		at: { x: box.left, y: box.bottom },
		via: "key",
		source: button,
	});
}

/**
 * Home first; then the pinned rooms and the owners' folders in their order; then the rest by latest
 * activity (agents and groups apart until there is a folder), each with its dispatch threads under
 * it, and what each is doing.
 */
export function RoomsPage(props: {
	onSearch(): void;
	/** The room open beside the list, marked in it; the list is then a column, not a page. */
	active?: string | undefined;
}) {
	// One string, so the page redraws only when the arrangement changes, not on every message.
	const shape = useSelector((state) =>
		JSON.stringify({
			listed: state.listed,
			...sections(state, (key) => activityAt(state, key)),
		}),
	);
	const { listed, ...arrangement } = useMemo(
		() => JSON.parse(shape) as { listed: boolean } & Sections,
		[shape],
	);
	const {
		home,
		pinned,
		folders,
		restAgents,
		restGroups,
		rest,
		threads,
		orphans,
	} = arrangement;
	const [arranging, setArranging] = useState(false);
	const folderIds = folders.map((folder) => folder.id).join(",");
	// A fold kept for a folder that was deleted meanwhile (on another device) is forgotten.
	useEffect(() => {
		if (listed) pruneCollapsed(folderIds ? folderIds.split(",") : []);
	}, [listed, folderIds]);
	const none =
		home.length + pinned.length + rest.length === 0 &&
		folders.every((folder) => folder.rooms.length === 0) &&
		orphans.open.length + orphans.closed.length === 0;
	const common = { threads, active: props.active, arranging };
	return (
		<div
			className="page"
			data-column={props.active ? "" : undefined}
			data-drop-root=""
		>
			<header className="page-head">
				<h1>{t("Rooms")}</h1>
				<div className="actions">
					<button
						type="button"
						className="secondary search-button"
						onClick={props.onSearch}
					>
						<Icon name="search" size={16} />
						<span>{t("Find a room")}</span>
						<kbd>⌘K</kbd>
					</button>
					{listed ? (
						<button
							type="button"
							className="icon-button"
							aria-haspopup="menu"
							aria-label={t("Folders and order")}
							onClick={(event) =>
								openRoomsMenu(event.currentTarget, arranging, setArranging)
							}
						>
							<Icon name="more" size={18} />
						</button>
					) : null}
					<button
						type="button"
						className="icon-button"
						aria-label={t("Add")}
						aria-haspopup="menu"
						onClick={(event) => openAddMenu(event.currentTarget)}
					>
						<Icon name="plus" />
					</button>
				</div>
			</header>
			{arranging ? (
				<div className="arrange-bar">
					<button
						type="button"
						className="secondary"
						onClick={() => askFolderDialog({ kind: "new" })}
					>
						<Icon name="plus" size={16} />
						<span>{t("Add a folder")}</span>
					</button>
					<button type="button" onClick={() => setArranging(false)}>
						{t("Done")}
					</button>
				</div>
			) : null}
			{listed && none ? (
				<Empty>
					{t("No rooms yet. Rooms appear when the team has an agent.")}
				</Empty>
			) : null}
			{!listed ? (
				<div className="stack" aria-busy="true">
					<div className="skeleton" />
					<div className="skeleton" />
					<div className="skeleton" />
				</div>
			) : null}
			<Section title={t("Home")} rooms={home} {...common} />
			<Section
				title={t("Pinned")}
				rooms={pinned}
				zone={{ kind: "pinned", id: "pinned" }}
				{...common}
			/>
			{folders.length > 0 ? (
				<div className="stack folder-list" data-folder-list="">
					{folders.map((folder) => (
						<FolderRooms key={folder.id} folder={folder} {...common} />
					))}
				</div>
			) : null}
			{folders.length > 0 ? (
				<Section
					title={t("Ungrouped")}
					rooms={rest}
					zone={{ kind: "rest", id: "rest" }}
					{...common}
				/>
			) : (
				<>
					<Section
						title={t("Agents")}
						rooms={restAgents}
						zone={{ kind: "rest", id: "rest-agents" }}
						{...common}
					/>
					<Section
						title={t("Groups")}
						rooms={restGroups}
						zone={{ kind: "rest", id: "rest-groups" }}
						{...common}
					/>
				</>
			)}
			{orphans.open.length + orphans.closed.length > 0 ? (
				<section className="stack">
					<h2 className="section-title">{t("Dispatch threads")}</h2>
					<ThreadList
						open={orphans.open}
						closed={orphans.closed}
						active={props.active}
					/>
				</section>
			) : null}
		</div>
	);
}
