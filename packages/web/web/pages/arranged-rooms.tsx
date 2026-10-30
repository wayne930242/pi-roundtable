import { lazy, memo, type ReactNode, Suspense, useMemo, useRef } from "react";
import { Icon } from "../components/icons.tsx";
import { Empty } from "../components/states.tsx";
import { openMenu } from "../lib/action-menu.ts";
import { useSelector } from "../lib/app-store.ts";
import { setArranging, useArranging } from "../lib/arrange.ts";
import { installArrangedStyle } from "../lib/arranged-style.ts";
import { useConfig } from "../lib/config.ts";
import { askFolderDialog } from "../lib/folder-dialogs.ts";
import { roomLifting } from "../lib/layout.ts";
import { useLifting } from "../lib/lifting.ts";
import { useLive } from "../lib/live.ts";
import { openAddMenu, roomMenuOf } from "../lib/menus.ts";
import { translate as t } from "../lib/messages.ts";
import { activityAt } from "../lib/rooms.ts";
import { openRoomsMenu } from "../lib/rooms-menu.ts";
import { useRowPress } from "../lib/row-press.ts";
import { type Sections, sections, type ThreadKeys } from "../lib/sections.ts";
import {
	HostKinds,
	RoomRowView,
	type RoomsPageProps,
	type RowData,
	ThreadList,
	useRowData,
} from "./rooms.tsx";

installArrangedStyle();

// The folders' drawing, their folds and their summaries load once there is a folder to draw.
const FolderList = lazy(() =>
	import("../components/folder-list.tsx").then((m) => ({
		default: m.FolderList,
	})),
);

/** A row the owners can lift: Home stays at the top; every other row can be dropped in a pinned list, a folder or the rest. */
const RoomRow = memo(function RoomRow(
	props: Omit<RowData, "key"> & {
		active: boolean;
		now: number;
		timeZone: string;
		threads?: ReactNode;
		/** The page is in arrange mode: a menu button sits beside the row. */
		arranging: boolean;
	},
) {
	const { view } = props;
	const press = useRowPress(
		() => roomMenuOf(view.key),
		view.home ? undefined : roomLifting(view.key),
	);
	return (
		<RoomRowView
			{...props}
			press={press}
			item={{
				...(view.home ? {} : { "data-drop-item": "", "data-key": view.key }),
				...(props.arranging ? { "data-arranging": "" } : {}),
			}}
			after={
				props.arranging ? (
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
				) : null
			}
		/>
	);
});

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
											parent={key}
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
	// The pinned list is a place to drop even before it holds a room: it shows while a row is lifted.
	const empty = shown.length === 0;
	if (empty && props.zone?.kind !== "pinned") return null;
	return (
		<section
			className="stack"
			{...(empty ? { "data-empty": "" } : {})}
			{...(props.zone
				? { "data-drop-zone": props.zone.kind, "data-zone-id": props.zone.id }
				: {})}
		>
			<h2 className="section-title">{props.title}</h2>
			{empty ? null : (
				<RoomList
					rooms={props.rooms}
					threads={props.threads}
					active={props.active}
					arranging={props.arranging}
				/>
			)}
		</section>
	);
}

/**
 * Home first; then the pinned rooms and the owners' folders in their order; then the rest by latest
 * activity (agents and groups apart until there is a folder), each with its dispatch threads under
 * it, and what each is doing. The page the room list becomes once anything is arranged.
 */
export function ArrangedRoomsPage(props: RoomsPageProps) {
	const hosted = Boolean(useConfig().kinds?.length);
	// One string, so the page redraws only when the arrangement changes, not on every message.
	const shape = useSelector((state) =>
		JSON.stringify({
			listed: state.listed,
			...sections(state, (key) => activityAt(state, key)),
		}),
	);
	// While a row is lifted the list keeps the order it had, whatever arrives; the latest shows once it is dropped.
	const lifting = useLifting();
	const kept = useRef(shape);
	if (!lifting) kept.current = shape;
	const frozen = kept.current;
	const { listed, ...arrangement } = useMemo(
		() => JSON.parse(frozen) as { listed: boolean } & Sections,
		[frozen],
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
	const arranging = useArranging();
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
						className="header-button search-button"
						onClick={props.onSearch}
					>
						<Icon name="search" size={16} />
						<span>{t("Find a room")}</span>
						<kbd>⌘K</kbd>
					</button>
					{listed ? (
						<button
							type="button"
							className="header-button icon-button"
							aria-haspopup="menu"
							aria-label={t("Folders and order")}
							onClick={(event) => openRoomsMenu(event.currentTarget)}
						>
							<Icon name="more" size={18} />
						</button>
					) : null}
					<button
						type="button"
						className="header-button icon-button"
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
			{listed && none && !hosted ? (
				<Empty>
					{t("No rooms yet. Rooms appear when the team has a knight.")}
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
					<Suspense fallback={<div className="skeleton" aria-busy="true" />}>
						<FolderList
							folders={folders}
							active={props.active}
							listed={listed}
							rooms={(keys) => (
								<RoomList
									rooms={keys}
									threads={threads}
									active={props.active}
									arranging={arranging}
								/>
							)}
						/>
					</Suspense>
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
						title={t("Knights")}
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
			<HostKinds active={props.active} />
		</div>
	);
}
