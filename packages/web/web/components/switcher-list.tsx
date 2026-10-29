import { useMemo, useRef, useState } from "react";
import { useSelector } from "../lib/app-store.ts";
import { installArrangedStyle } from "../lib/arranged-style.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { fuzzyScore } from "../lib/fuzzy.ts";
import { composingKey } from "../lib/ime.ts";
import { roomLifting } from "../lib/layout.ts";
import { activityAt } from "../lib/layout-now.ts";
import { useLifting } from "../lib/lifting.ts";
import { openAddMenu, roomMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { waitingCards } from "../lib/rooms.ts";
import { hrefFor, navigate } from "../lib/router.ts";
import { useRowPress } from "../lib/row-press.ts";
import { drawerGroups } from "../lib/sections.ts";
import { Icon } from "./icons.tsx";
import { RoomPicture } from "./room-picture.tsx";

installArrangedStyle();

/** What the drawer lists of a room: key, name, and whether a card waits there. */
interface Entry {
	key: string;
	name: string;
	waiting: boolean;
}

/** A run of rows under one heading: the waiting rooms, the pinned ones, a folder, or the rest. */
interface Group {
	id: string;
	title?: string;
	entries: Entry[];
}

function useGroups(): Group[] {
	const shape = useSelector((state) =>
		JSON.stringify(
			drawerGroups(
				state,
				(key) => activityAt(state, key),
				(key) => waitingCards(state, key) > 0,
				true,
			).map((group) => ({
				id: group.id,
				...(group.title === undefined ? {} : { title: group.title }),
				entries: group.keys.map((key) => ({
					key,
					name: state.rooms[key]?.view?.displayName ?? key,
					waiting: waitingCards(state, key) > 0,
				})),
			})),
		),
	);
	// While a row is lifted the drawer keeps the order it had; the latest shows once it is dropped.
	const lifting = useLifting();
	const kept = useRef(shape);
	if (!lifting) kept.current = shape;
	const frozen = kept.current;
	return useMemo(() => JSON.parse(frozen) as Group[], [frozen]);
}

function Row(props: {
	entry: Entry;
	current: string;
	onPick(key: string): void;
	/** Closes the drawer, then runs what leaves the room. */
	onLeave(go: () => void): void;
	/** The row can be lifted and dropped in another list. */
	liftable: boolean;
}) {
	const { key, name } = props.entry;
	const room = useSelector((state) => state.rooms[key]);
	const waiting = useSelector((state) => waitingCards(state, key));
	const view = room?.view;
	const accent = useAccentStyle(view?.character);
	const press = useRowPress(
		() => roomMenuOf(key, props.onLeave),
		props.liftable && !view?.home ? roomLifting(key) : undefined,
	);
	if (!view) return null;
	return (
		<li
			{...(props.liftable && !view.home
				? { "data-drop-item": "", "data-key": key }
				: {})}
		>
			<a
				className="switcher-row"
				{...press}
				href={hrefFor("room", key)}
				aria-current={key === props.current ? "page" : undefined}
				style={accent}
				onClick={(event) => {
					if (
						event.button !== 0 ||
						event.metaKey ||
						event.ctrlKey ||
						event.shiftKey ||
						event.altKey
					)
						return;
					event.preventDefault();
					props.onPick(key);
				}}
			>
				<span className="switcher-picture">
					<RoomPicture view={view} size={40} />
					{waiting ? (
						<span className="switcher-dot" aria-hidden="true" />
					) : null}
				</span>
				<span className="switcher-name">
					<strong>{name}</strong>
					{room?.typing ? (
						<span className="switcher-working">
							<span className="typing" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
							{t("Working")}
						</span>
					) : null}
				</span>
				{waiting ? (
					<span className="badge badge-warn">
						{plural(waiting, "{count} card waiting", "{count} cards waiting")}
					</span>
				) : null}
				{view.muted ? (
					<span
						className="switcher-mode"
						data-mode="muted"
						title={t("Notifications are off")}
					>
						<Icon name="bell-off" size={14} />
						<span className="visually-hidden">
							{t("Notifications are off")}
						</span>
					</span>
				) : null}
				{room?.mode.yolo ? (
					<span className="switcher-mode" data-mode="yolo" title={t("Yolo")}>
						<Icon name="bolt" size={14} />
						<span className="visually-hidden">{t("Yolo")}</span>
					</span>
				) : null}
				{room?.mode.longRunning ? (
					<span
						className="switcher-mode"
						data-mode="long"
						title={t("Long-running")}
					>
						<Icon name="timer" size={14} />
						<span className="visually-hidden">{t("Long-running")}</span>
					</span>
				) : null}
			</a>
		</li>
	);
}

/** The drawer's rooms: the waiting ones, the pinned ones, each folder and the rest, each under a heading once anything is arranged. */
export function SwitcherList(props: {
	current: string;
	close(then?: () => void): void;
}) {
	const [query, setQuery] = useState("");
	const groups = useGroups();
	const shown = groups
		.map((group) => ({
			...group,
			entries: group.entries.filter(
				(entry) => fuzzyScore(query, entry.name) !== undefined,
			),
		}))
		// Empty groups wait, hidden, for a row to be lifted over them; a search shows only what matches.
		.filter((group) => group.entries.length > 0 || query === "");
	const pick = (key: string) =>
		props.close(
			key === props.current ? undefined : () => navigate("room", key),
		);
	// Once rooms are pinned or in folders, the rest is the "Ungrouped" the room list calls it.
	// The pinned list is always there to drop a room in; it counts once it holds one.
	const restTitle = groups.some(
		(group) =>
			group.id !== "waiting" &&
			group.id !== "rest" &&
			(group.id !== "pinned" || group.entries.length > 0),
	)
		? t("Ungrouped")
		: t("Rooms");
	const headed = shown.filter((group) => group.entries.length > 0).length > 1;
	return (
		<>
			<div className="switcher-search">
				<Icon name="search" size={16} />
				<input
					type="search"
					value={query}
					placeholder={t("Find a room")}
					aria-label={t("Find a room")}
					enterKeyHint="go"
					autoComplete="off"
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						const first = shown.flatMap((group) => group.entries)[0];
						if (
							event.key === "Enter" &&
							first &&
							!composingKey(event.nativeEvent)
						)
							pick(first.key);
					}}
				/>
				<button
					type="button"
					className="icon-button switcher-add"
					aria-label={t("Add")}
					aria-haspopup="menu"
					onClick={(event) => openAddMenu(event.currentTarget, props.close)}
				>
					<Icon name="plus" />
				</button>
			</div>
			<div className="switcher-scroll" data-drop-root="">
				{shown.map((group) => {
					const waiting = group.id === "waiting";
					const zone =
						group.id === "pinned"
							? "pinned"
							: group.id === "rest"
								? "rest"
								: waiting
									? undefined
									: "folder";
					return (
						<section
							key={group.id}
							aria-label={
								waiting
									? t("Waiting for you")
									: group.id === "pinned"
										? t("Pinned")
										: group.id === "rest"
											? restTitle
											: (group.title ?? t("Rooms"))
							}
							{...(group.entries.length === 0 ? { "data-empty": "" } : {})}
							{...(zone
								? {
										"data-drop-zone": zone,
										"data-zone-id": group.id,
										...(zone === "folder" ? { "data-folder": group.id } : {}),
									}
								: {})}
						>
							{waiting ? (
								<h2 className="switcher-heading" data-waiting="">
									{t("Waiting for you")}
								</h2>
							) : headed || group.entries.length === 0 ? (
								<h2 className="switcher-heading">
									{group.id === "pinned"
										? t("Pinned")
										: group.id === "rest"
											? restTitle
											: group.title}
								</h2>
							) : null}
							<ul className="switcher-list">
								{group.entries.map((entry) => (
									<Row
										key={entry.key}
										entry={entry}
										current={props.current}
										onPick={pick}
										onLeave={props.close}
										liftable={!waiting}
									/>
								))}
							</ul>
						</section>
					);
				})}
			</div>
		</>
	);
}
