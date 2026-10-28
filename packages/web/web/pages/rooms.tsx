import { memo, useMemo } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { Avatar } from "../components/avatar.tsx";
import { Icon } from "../components/icons.tsx";
import { Empty } from "../components/states.tsx";
import { useSelector } from "../lib/app-store.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
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

const RoomRow = memo(function RoomRow(props: {
	view: RoomView;
	typing: boolean;
	yolo: boolean;
	longRunning: boolean;
	waiting: number;
	active: boolean;
	preview: string;
	at: string | undefined;
	now: number;
	timeZone: string;
}) {
	const { view } = props;
	return (
		<li>
			<a
				className="room-row"
				href={hrefFor("room", view.key)}
				data-home={view.home || undefined}
				aria-current={props.active ? "page" : undefined}
			>
				<Avatar
					name={view.displayName}
					src={view.avatar}
					size={view.home ? 52 : 44}
				/>
				<span className="room-row-main">
					<span className="room-row-top">
						<strong>{view.displayName}</strong>
						{view.home ? (
							<span className="badge badge-accent">{t("Home")}</span>
						) : null}
						{view.kind === "group" ? (
							<span className="badge">{t("Group")}</span>
						) : null}
						{view.kind === "thread" ? (
							<span className="badge">{t("Thread")}</span>
						) : null}
						<span className="room-row-time">
							{props.at ? ago(props.at, props.now, props.timeZone) : ""}
						</span>
					</span>
					<span className="room-row-preview">
						{props.typing ? (
							<span className="typing" role="img" aria-label={t("Working")}>
								<i />
								<i />
								<i />
							</span>
						) : null}
						<span>{props.preview || t("No messages yet")}</span>
					</span>
					<span className="room-row-badges">
						{props.waiting ? (
							<span className="badge badge-warn">
								{plural(
									props.waiting,
									"{count} card waiting",
									"{count} cards waiting",
								)}
							</span>
						) : null}
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
		</li>
	);
});

function Section(props: {
	title: string;
	rooms: string[];
	active: string | undefined;
}) {
	const { now } = useLive();
	const { timeZone } = useConfig();
	const rows = useSelector(
		(state) =>
			props.rooms.map((key) => {
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
		props.rooms.join(","),
	);
	const shown = rows.flatMap((row) =>
		row.view ? [{ ...row, view: row.view }] : [],
	);
	if (shown.length === 0) return null;
	return (
		<section className="stack">
			<h2 className="section-title">{props.title}</h2>
			<ul className="room-list">
				{shown.map(({ key, ...row }) => (
					<RoomRow
						key={key}
						{...row}
						active={key === props.active}
						now={now}
						timeZone={timeZone}
					/>
				))}
			</ul>
		</section>
	);
}

/** Home first, then the agents, the groups, and the dispatch threads, with what each is doing. */
export function RoomsPage(props: {
	onSearch(): void;
	/** The room open beside the list, marked in it; the list is then a column, not a page. */
	active?: string | undefined;
}) {
	// One string, so the page redraws only when the grouping changes, not on every message.
	const shape = useSelector((state) => {
		const groups: Record<"home" | "agents" | "groups" | "threads", string[]> = {
			home: [],
			agents: [],
			groups: [],
			threads: [],
		};
		for (const key of state.order) {
			const view = state.rooms[key]?.view;
			if (!view) continue;
			if (view.home) groups.home.push(key);
			else if (view.kind === "agent") groups.agents.push(key);
			else if (view.kind === "group") groups.groups.push(key);
			else groups.threads.push(key);
		}
		return JSON.stringify({ listed: state.listed, groups });
	});
	const { listed, groups } = useMemo(
		() =>
			JSON.parse(shape) as {
				listed: boolean;
				groups: Record<"home" | "agents" | "groups" | "threads", string[]>;
			},
		[shape],
	);
	const none = Object.values(groups).every((list) => list.length === 0);
	return (
		<div className="page" data-column={props.active ? "" : undefined}>
			<header className="page-head">
				<h1>{t("Rooms")}</h1>
				<button
					type="button"
					className="secondary search-button"
					onClick={props.onSearch}
				>
					<Icon name="search" size={16} />
					<span>{t("Find a room")}</span>
					<kbd>⌘K</kbd>
				</button>
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
			<Section title={t("Home")} rooms={groups.home} active={props.active} />
			<Section
				title={t("Agents")}
				rooms={groups.agents}
				active={props.active}
			/>
			<Section
				title={t("Groups")}
				rooms={groups.groups}
				active={props.active}
			/>
			<Section
				title={t("Dispatch threads")}
				rooms={groups.threads}
				active={props.active}
			/>
		</div>
	);
}
