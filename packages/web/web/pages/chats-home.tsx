import { useMemo, useRef, useState } from "react";
import { Icon } from "../components/icons.tsx";
import { PinTile } from "../components/pin-tile.tsx";
import { useReadSwipe } from "../components/read-swipe.tsx";
import { Empty } from "../components/states.tsx";
import { useSelector } from "../lib/app-store.ts";
import { useArchivedCount } from "../lib/archived-count.ts";
import { lastChip, rememberChip } from "../lib/chat-chip.ts";
import {
	chipsOf,
	elsewhereUnread,
	folderOf,
	hiddenDot,
	listFor,
	pinSizeOf,
	pinsOf,
} from "../lib/chats-home.ts";
import { installChatsHomeStyle } from "../lib/chats-home-style.ts";
import { useConfig } from "../lib/config.ts";
import "../lib/home-icons.ts";
import { AllFeatures } from "../components/all-features.tsx";
import { ChatRow } from "../components/chat-row.tsx";
import HiddenRow from "../components/hidden-row.tsx";
import { HomeChips } from "../components/home-chips.tsx";
import { HomeTop } from "../components/home-top.tsx";
import { useLive } from "../lib/live.ts";
import { openAddMenu } from "../lib/menus.ts";
import { translate as t } from "../lib/messages.ts";
import { activityAt } from "../lib/rooms.ts";
import { type Sections, sections } from "../lib/sections.ts";
import { useUnreadMap } from "../lib/unread-map.ts";
import { HostKinds, useRowData } from "./rooms.tsx";

export interface ChatsHomeProps {
	onSearch(): void;
	/** The room open beside the list, marked in it. */
	active?: string | undefined;
	/** The list is a column beside the room (or its empty place), not the page. */
	column?: boolean;
}

/**
 * The home as a chat list: the pinned rooms as big figures on top, folders as chips that filter one
 * list of the other rooms by latest activity, one row for the hidden rooms and the archive, and at
 * the bottom the button to everything else and the search.
 */
export default function ChatsHome(props: ChatsHomeProps) {
	installChatsHomeStyle();
	const page = useRef<HTMLDivElement>(null);
	useReadSwipe(page);
	const { now } = useLive();
	const { timeZone } = useConfig();
	// One string, so the page redraws only when the arrangement changes, not on every message.
	const shape = useSelector((state) =>
		JSON.stringify({
			listed: state.listed,
			order: state.order,
			...sections(state, (key) => activityAt(state, key)),
		}),
	);
	const { listed, order, ...arrangement } = useMemo(
		() => JSON.parse(shape) as { listed: boolean; order: string[] } & Sections,
		[shape],
	);
	// The times are read when the list is built; a message moves its room up, which changes `shape`.
	const times = useSelector((state) =>
		JSON.stringify(
			Object.fromEntries(order.map((key) => [key, activityAt(state, key)])),
		),
	);
	const at = useMemo(() => {
		const known = JSON.parse(times) as Record<string, number>;
		return (key: string) => known[key] ?? Number.NEGATIVE_INFINITY;
	}, [times]);
	const [chosen, choose] = useState(lastChip);
	const chips = chipsOf(arrangement);
	const chip = chips.some((one) => one.id === chosen) ? chosen : "all";
	const unread = useUnreadMap();
	const listKeys = listFor(arrangement, chip, at, order);
	const elsewhere = elsewhereUnread(arrangement, chip, unread, at, order);
	const pins = pinsOf(arrangement);
	const activeChip = chips.find((one) => one.id === chip);
	const activeName =
		activeChip?.kind === "folder"
			? activeChip.name
			: activeChip?.kind === "other"
				? t("Other")
				: undefined;
	const rows = useRowData([
		...pins,
		...listKeys,
		...elsewhere.map((one) => one.key),
	]);
	const byKey = new Map(rows.map((row) => [row.key, row]));
	// On a phone the pins sit in a dock at the bottom, under the thumb; a column keeps them on top.
	const dock = !props.column && props.active === undefined;
	// Where the list mixes folders, each row says which one it is in.
	const tagged = chips.length > 0 && chip === "all";
	const archived = useArchivedCount();
	const hidden = arrangement.hidden.length;
	const none = listed && pins.length + listKeys.length === 0 && hidden === 0;
	const hosted = Boolean(useConfig().kinds?.length);
	const [features, setFeatures] = useState(false);
	const rowFor = (key: string, folder?: { id: string; name: string }) => {
		const row = byKey.get(key);
		if (!row) return null;
		const { key: _key, ...data } = row;
		return (
			<ChatRow
				key={key}
				{...data}
				active={key === props.active}
				now={now}
				timeZone={timeZone}
				threads={arrangement.threads[key]?.open.length ?? 0}
				unread={unread[key] ?? 0}
				folder={folder?.name}
			/>
		);
	};
	const list = (
		<ul className="room-list chat-list">
			{listKeys.map((key) =>
				rowFor(key, tagged ? folderOf(arrangement, key) : undefined),
			)}
		</ul>
	);
	const pinsList =
		pins.length > 0 ? (
			<ul className={dock ? "pins pin-dock" : "pins"} aria-label={t("Pinned")}>
				{pins.map((key) => {
					const row = byKey.get(key);
					if (!row) return null;
					const { key: _key, ...data } = row;
					return (
						<PinTile
							key={key}
							{...data}
							active={key === props.active}
							size={pinSizeOf(props)}
							unread={unread[key] ?? 0}
						/>
					);
				})}
			</ul>
		) : null;
	return (
		<div
			ref={page}
			className="page chats"
			data-column={props.active !== undefined || props.column ? "" : undefined}
		>
			<HomeTop onAdd={(button) => openAddMenu(button)} />
			{!listed ? (
				<div className="stack" aria-busy="true">
					<div className="skeleton" />
					<div className="skeleton" />
				</div>
			) : null}
			{none && !hosted ? (
				<Empty>
					{t("No rooms yet. Rooms appear when the team has a knight.")}
				</Empty>
			) : null}
			{!dock ? pinsList : null}
			{chips.length > 0 ? (
				<HomeChips
					chips={chips}
					chosen={chip}
					unread={unread}
					onChoose={(id) => {
						rememberChip(id);
						choose(id);
					}}
				/>
			) : null}
			{elsewhere.length > 0 ? (
				<section className="elsewhere">
					<h2>{t("Other unread")}</h2>
					<ul className="room-list chat-list elsewhere-list">
						{elsewhere.map((one) => rowFor(one.key, one.folder))}
					</ul>
				</section>
			) : null}
			{elsewhere.length > 0 && activeName !== undefined ? (
				<section className="folder-section">
					<h2>{activeName}</h2>
					{list}
				</section>
			) : (
				list
			)}
			{hidden + (archived ?? 0) > 0 ? (
				<HiddenRow
					hidden={hidden}
					archived={archived ?? 0}
					dot={hiddenDot(arrangement.hidden, unread)}
				/>
			) : null}
			<HostKinds active={props.active} />
			<div className="chats-foot">
				{dock ? pinsList : null}
				<div className="chats-bar">
					<button
						type="button"
						className="icon-button chats-grid"
						aria-label={t("All features")}
						aria-haspopup="dialog"
						onClick={() => setFeatures(true)}
					>
						<Icon name="grid" />
					</button>
					<button
						type="button"
						className="chats-search"
						onClick={props.onSearch}
					>
						<Icon name="search" size={18} />
						<span>{t("Find a room")}</span>
						<kbd>⌘K</kbd>
					</button>
				</div>
			</div>
			<AllFeatures open={features} onClose={() => setFeatures(false)} />
		</div>
	);
}
