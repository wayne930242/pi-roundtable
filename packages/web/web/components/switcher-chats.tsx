import { useRef, useState } from "react";
import { useSelector } from "../lib/app-store.ts";
import { lastChip, rememberChip } from "../lib/chat-chip.ts";
import { useChatsArrangement } from "../lib/chats-arrangement.ts";
import {
	chipsOf,
	elsewhereUnread,
	folderOf,
	listFor,
	pinsOf,
} from "../lib/chats-home.ts";
import { installChatsHomeStyle } from "../lib/chats-home-style.ts";
import { useConfig } from "../lib/config.ts";
import { fuzzyScore } from "../lib/fuzzy.ts";
import { goInside } from "../lib/go-inside.ts";
import "../lib/home-icons.ts";
import { composingKey } from "../lib/ime.ts";
import { useLive } from "../lib/live.ts";
import { openAddMenu } from "../lib/menus.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import { installSwitcherChatsStyle } from "../lib/switcher-chats-style.ts";
import { useUnreadMap } from "../lib/unread-map.ts";
import { ThreadList, useRowData } from "../pages/rooms.tsx";
import { ChatRow } from "./chat-row.tsx";
import { HomeChips } from "./home-chips.tsx";
import { Icon } from "./icons.tsx";
import { PinTile } from "./pin-tile.tsx";
import { useReadSwipe } from "./read-swipe.tsx";

/**
 * The room drawer on a phone of a host with the chat home, laid out as the home is: the folder tabs
 * (the tab the home last had), the rows, other folders' unread rooms, the pins in a dock, and a bar with
 * Home, the search and the add menu. What only a drawer can do: the open room's dispatch threads lead
 * the list, so another thread of the room is one swipe and one tap away, from the room or from any thread.
 * The rows, pins and tabs are the home's, so the figures move as they do there.
 */
export default function SwitcherChats(props: {
	current: string;
	close(then?: () => void): void;
}) {
	installChatsHomeStyle();
	installSwitcherChatsStyle();
	const scroll = useRef<HTMLDivElement>(null);
	useReadSwipe(scroll);
	const { now } = useLive();
	const { timeZone } = useConfig();
	const { order, arrangement, at } = useChatsArrangement();
	const [chosen, choose] = useState(lastChip);
	const [query, setQuery] = useState("");
	const chips = chipsOf(arrangement);
	const chip = chips.some((one) => one.id === chosen) ? chosen : "all";
	const unread = useUnreadMap();
	const pins = pinsOf(arrangement);
	const listKeys = listFor(arrangement, chip, at, order);
	const elsewhere = elsewhereUnread(arrangement, chip, unread, at, order);
	// Every room the drawer can show, the pinned first as the palette lists them: hidden rooms are not here.
	const rows = useRowData([...pins, ...listFor(arrangement, "all", at, order)]);
	const byKey = new Map(rows.map((row) => [row.key, row]));
	const activeChip = chips.find((one) => one.id === chip);
	const activeName =
		activeChip?.kind === "folder"
			? activeChip.name
			: activeChip?.kind === "other"
				? t("Other")
				: undefined;
	// The knight whose threads these are: the open room, or the room an open thread or temp knight hangs under.
	const family = useSelector((state) => {
		const open = state.rooms[props.current]?.view;
		return open?.helper?.parent ?? open?.parent ?? props.current;
	});
	const familyName = useSelector(
		(state) => state.rooms[family]?.view?.displayName ?? family,
	);
	const threads = arrangement.threads[family];
	const searching = query.trim() !== "";
	const found = searching
		? rows.filter(
				(row) => fuzzyScore(query, row.view.displayName) !== undefined,
			)
		: [];
	const pick = (key: string) =>
		props.close(
			key === props.current ? undefined : () => navigate("room", key),
		);
	const rowFor = (key: string, folder?: { id: string; name: string }) => {
		const row = byKey.get(key);
		if (!row) return null;
		const { key: _key, ...data } = row;
		return (
			<ChatRow
				key={key}
				{...data}
				active={key === props.current}
				now={now}
				timeZone={timeZone}
				threads={arrangement.threads[key]?.open.length ?? 0}
				unread={unread[key] ?? 0}
				folder={folder?.name}
				leave={props.close}
			/>
		);
	};
	const list = (
		<ul className="room-list chat-list">
			{listKeys.map((key) =>
				rowFor(
					key,
					chips.length > 0 && chip === "all"
						? folderOf(arrangement, key)
						: undefined,
				),
			)}
		</ul>
	);
	const listHeading =
		elsewhere.length > 0 && activeName !== undefined
			? activeName
			: threads
				? (activeName ?? t("Rooms"))
				: undefined;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the links inside take the keys; this only closes the drawer on their way out
		<div className="switcher-chats" onClick={(event) => goInside(event, pick)}>
			{chips.length > 0 && !searching ? (
				// The tabs scroll sideways, so a swipe over them is theirs, not the drawer's.
				<div className="switcher-tabs" data-swipe-ignore="">
					<HomeChips
						chips={chips}
						chosen={chip}
						unread={unread}
						onChoose={(id) => {
							rememberChip(id);
							choose(id);
						}}
					/>
				</div>
			) : null}
			<div className="switcher-scroll" ref={scroll}>
				{searching ? (
					<ul className="room-list chat-list">
						{found.map((row) => rowFor(row.key))}
					</ul>
				) : (
					<>
						{threads ? (
							<section className="switcher-chats-threads">
								<h2>{t("{name}'s dispatch threads", { name: familyName })}</h2>
								{/* A thread card is swiped to clear it, not to close the drawer. */}
								<div data-swipe-ignore="">
									<ThreadList
										open={threads.open}
										closed={threads.closed}
										active={props.current}
										parent={family}
									/>
								</div>
							</section>
						) : null}
						{elsewhere.length > 0 ? (
							<section className="elsewhere">
								<h2>{t("Other unread")}</h2>
								<ul className="room-list chat-list elsewhere-list">
									{elsewhere.map((one) => rowFor(one.key, one.folder))}
								</ul>
							</section>
						) : null}
						{listHeading !== undefined ? (
							<section className="folder-section">
								<h2>{listHeading}</h2>
								{list}
							</section>
						) : (
							list
						)}
					</>
				)}
			</div>
			{pins.length > 0 && !searching ? (
				<ul className="pins pin-dock" aria-label={t("Pinned")}>
					{pins.map((key) => {
						const row = byKey.get(key);
						if (!row) return null;
						const { key: _key, ...data } = row;
						return (
							<PinTile
								key={key}
								{...data}
								active={key === props.current}
								size={48}
								unread={unread[key] ?? 0}
								leave={props.close}
							/>
						);
					})}
				</ul>
			) : null}
			<div className="switcher-bar">
				<button
					type="button"
					className="icon-button switcher-bar-button"
					aria-label={t("Home")}
					onClick={() => props.close(() => navigate("rooms"))}
				>
					<Icon name="home" />
				</button>
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
							const first = found[0];
							if (
								event.key === "Enter" &&
								first &&
								!composingKey(event.nativeEvent)
							)
								pick(first.key);
						}}
					/>
				</div>
				<button
					type="button"
					className="icon-button switcher-bar-button"
					aria-label={t("Add")}
					aria-haspopup="menu"
					onClick={(event) => openAddMenu(event.currentTarget, props.close)}
				>
					<Icon name="plus" />
				</button>
			</div>
		</div>
	);
}
