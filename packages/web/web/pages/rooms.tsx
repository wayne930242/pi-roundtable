import { memo, type ReactNode, useMemo } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { RoomPicture } from "../components/room-picture.tsx";
import { Empty } from "../components/states.tsx";
import { useSelector } from "../lib/app-store.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { useMenuPress } from "../lib/menu-press.ts";
import { openAddMenu, roomMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { lastMessage, waitingCards } from "../lib/rooms.ts";
import { hrefFor } from "../lib/router.ts";

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
	},
) {
	const { view } = props;
	const accent = useAccentStyle(view.character);
	const press = useMenuPress(() => roomMenuOf(view.key));
	return (
		<li>
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

function Section(props: {
	title: string;
	rooms: string[];
	threads: Record<string, ThreadKeys>;
	active: string | undefined;
}) {
	const { now } = useLive();
	const { timeZone } = useConfig();
	const shown = useRowData(props.rooms);
	if (shown.length === 0) return null;
	return (
		<section className="stack">
			<h2 className="section-title">{props.title}</h2>
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
		</section>
	);
}

/** A room's dispatch threads by key, open and finished. */
interface ThreadKeys {
	open: string[];
	closed: string[];
}

/** Home first, then the agents and the groups, each with its dispatch threads under it, and what each is doing. */
export function RoomsPage(props: {
	onSearch(): void;
	/** The room open beside the list, marked in it; the list is then a column, not a page. */
	active?: string | undefined;
}) {
	// One string, so the page redraws only when the grouping changes, not on every message.
	const shape = useSelector((state) => {
		const groups: Record<"home" | "agents" | "groups", string[]> = {
			home: [],
			agents: [],
			groups: [],
		};
		const threads: Record<string, ThreadKeys> = {};
		const known = new Set(
			state.order.filter((key) => state.rooms[key]?.view?.kind !== "thread"),
		);
		/** Threads whose room the list no longer has still show, apart. */
		const orphans: ThreadKeys = { open: [], closed: [] };
		for (const key of state.order) {
			const view = state.rooms[key]?.view;
			if (!view) continue;
			if (view.kind === "thread") {
				const parentKeys =
					view.parent && known.has(view.parent) ? view.parent : undefined;
				let into = orphans;
				if (parentKeys) {
					into = threads[parentKeys] ?? { open: [], closed: [] };
					threads[parentKeys] = into;
				}
				(view.closed ? into.closed : into.open).push(key);
			} else if (view.home) groups.home.push(key);
			else if (view.kind === "agent") groups.agents.push(key);
			else groups.groups.push(key);
		}
		return JSON.stringify({ listed: state.listed, groups, threads, orphans });
	});
	const { listed, groups, threads, orphans } = useMemo(
		() =>
			JSON.parse(shape) as {
				listed: boolean;
				groups: Record<"home" | "agents" | "groups", string[]>;
				threads: Record<string, ThreadKeys>;
				orphans: ThreadKeys;
			},
		[shape],
	);
	const none =
		Object.values(groups).every((list) => list.length === 0) &&
		orphans.open.length + orphans.closed.length === 0;
	return (
		<div className="page" data-column={props.active ? "" : undefined}>
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
			<Section
				title={t("Home")}
				rooms={groups.home}
				threads={threads}
				active={props.active}
			/>
			<Section
				title={t("Agents")}
				rooms={groups.agents}
				threads={threads}
				active={props.active}
			/>
			<Section
				title={t("Groups")}
				rooms={groups.groups}
				threads={threads}
				active={props.active}
			/>
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
