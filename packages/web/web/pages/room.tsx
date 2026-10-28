import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { RoomMessage } from "../../src/api-types.ts";
import { PromptCard } from "../components/cards.tsx";
import { CharacterStack, PageCharacter } from "../components/character.tsx";
import { Composer } from "../components/composer.tsx";
import { Confirm } from "../components/confirm.tsx";
import { GroupTable } from "../components/group-table.tsx";
import { Icon } from "../components/icons.tsx";
import { LiveRow, MessageRow, PendingRow } from "../components/message-row.tsx";
import { ModeBanner } from "../components/mode-banner.tsx";
import { ProgressStrip } from "../components/progress-strip.tsx";
import { RoomMenu } from "../components/room-menu.tsx";
import { Empty, Failure } from "../components/states.tsx";
import { api, messageOf } from "../lib/api.ts";
import { store, useSelector } from "../lib/app-store.ts";
import {
	useAccentStyle,
	useCharacters,
	useRoomState,
} from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { dayKey, dayLabel } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { translate as t } from "../lib/messages.ts";
import { reducedMotion } from "../lib/motion.ts";
import { ROOM_PAGE, type TimelineItem, timeline } from "../lib/rooms.ts";
import { hrefFor } from "../lib/router.ts";
import { useConnection } from "../lib/socket.ts";
import { toast } from "../lib/toast.ts";

/** A pause this long between two messages of one author shows the author again. */
const PAUSE_MS = 5 * 60_000;
const PAGE = ROOM_PAGE;

/**
 * Keeps the end of the list in view while the person is at the end, and says when more arrived
 * while they were not. A scroll event caused by the content growing is not the person moving, so
 * only scrolls that leave the height as it was count as theirs.
 */
function useStickToEnd(scroller: React.RefObject<HTMLDivElement | null>) {
	const stuck = useRef(true);
	const height = useRef(0);
	const [away, setAway] = useState(false);
	const onScroll = useCallback(() => {
		const element = scroller.current;
		if (!element) return;
		if (element.scrollHeight !== height.current) {
			height.current = element.scrollHeight;
			return;
		}
		stuck.current =
			element.scrollHeight - element.scrollTop - element.clientHeight < 96;
		setAway(!stuck.current);
	}, [scroller]);
	/** The content changed size: follow it to the end, or note that there is more below. */
	const onGrow = useCallback(() => {
		const element = scroller.current;
		if (!element) return;
		height.current = element.scrollHeight;
		if (stuck.current) element.scrollTo({ top: element.scrollHeight });
		else setAway(true);
	}, [scroller]);
	const toEnd = useCallback(
		(smooth: boolean) => {
			const element = scroller.current;
			if (!element) return;
			stuck.current = true;
			height.current = element.scrollHeight;
			element.scrollTo({
				top: element.scrollHeight,
				behavior: smooth && !reducedMotion() ? "smooth" : "auto",
			});
			setAway(false);
		},
		[scroller],
	);
	return { away, onScroll, onGrow, toEnd };
}

export function RoomPage({ roomKey }: { roomKey: string }) {
	const connection = useConnection();
	const config = useConfig();
	const { now } = useLive();
	const room = useSelector((state) => state.rooms[roomKey]);
	const listed = useSelector((state) => state.listed);
	const connects = useSelector((state) => state.connects);
	const open = useSelector((state) => state.connection === "open");
	const limits = useSelector((state) => state.limits);
	const parts = useSelector((state) => ({
		rooms: state.rooms,
		cards: state.cards,
		cardOrder: state.cardOrder,
	}));
	const characters = useCharacters();
	const state = useRoomState(roomKey);
	const view = room?.view;
	// A dispatch thread has no character of its own; it wears its parent room's.
	const parentView = view?.parent ? parts.rooms[view.parent]?.view : undefined;
	const character = view?.character ?? parentView?.character;
	const accent = useAccentStyle(character);
	const [error, setError] = useState<string>();
	const [loaded, setLoaded] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [menu, setMenu] = useState(false);
	/** Under the header: where a group's table strip and panel go. */
	const [tableSlot, setTableSlot] = useState<HTMLDivElement | null>(null);
	const [confirm, setConfirm] = useState<"yolo" | "start-over">();
	const [dropped, setDropped] = useState<File[]>();
	const menuButton = useRef<HTMLButtonElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { away, onScroll, onGrow, toEnd } = useStickToEnd(scroller);
	const mountedLast = useRef<number | undefined>(undefined);
	const prepend = useRef<number | undefined>(undefined);

	// The page shows this room, so its progress streams here.
	useEffect(() => {
		connection.focus(roomKey);
		return () => connection.focus(undefined);
	}, [connection, roomKey]);

	// The latest page, on opening and after every reconnect, merged with what frames brought.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the room and the connection count say when to fetch
	useEffect(() => {
		let current = true;
		api.messages(roomKey, undefined, PAGE).then(
			(page) => {
				if (!current) return;
				store.dispatch({
					type: "history_loaded",
					room: roomKey,
					messages: page.messages,
					more: page.more,
					older: false,
				});
				setError(undefined);
				setLoaded(true);
			},
			(failure) => {
				if (current) setError(messageOf(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [roomKey, connects]);

	const items = useMemo(() => timeline(parts, roomKey), [parts, roomKey]);

	// New messages slide in; the ones present when the room opened do not.
	if (loaded && mountedLast.current === undefined)
		mountedLast.current = room?.messages.at(-1)?.id ?? 0;

	// Opening a room lands at its end.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the first load jumps
	useLayoutEffect(() => {
		if (loaded) toEnd(false);
	}, [loaded]);

	// Older messages added above must not move what the person reads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the first message's id says older ones came
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && prepend.current !== undefined) {
			element.scrollTop += element.scrollHeight - prepend.current;
			prepend.current = undefined;
		}
	}, [room?.messages[0]?.id]);

	// Whatever grows the list (a message, a stream, an image) keeps the end in view for a person who is at it.
	useEffect(() => {
		const element = content.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const watcher = new ResizeObserver(onGrow);
		watcher.observe(element);
		return () => watcher.disconnect();
	}, [onGrow]);

	const loadOlder = async () => {
		const first = room?.messages[0];
		if (!first || loadingOlder) return;
		setLoadingOlder(true);
		prepend.current = scroller.current?.scrollHeight;
		try {
			const page = await api.messages(roomKey, first.id, PAGE);
			store.dispatch({
				type: "history_loaded",
				room: roomKey,
				messages: page.messages,
				more: page.more,
				older: true,
			});
		} catch (failure) {
			prepend.current = undefined;
			toast(messageOf(failure), "danger");
		} finally {
			setLoadingOlder(false);
		}
	};

	const headerOf = (message: RoomMessage, before: RoomMessage | undefined) =>
		!before ||
		before.kind !== message.kind ||
		before.author !== message.author ||
		Date.parse(message.at) - Date.parse(before.at) > PAUSE_MS;
	const rows = useRows(items, config.timeZone, now, headerOf);

	// A thread's link can arrive before the room list does; ask for the list once before giving up.
	const [rechecked, setRechecked] = useState(false);
	const unknown = listed && !view;
	useEffect(() => {
		if (!unknown || rechecked) return;
		let current = true;
		api.rooms().then(
			(listing) => {
				store.dispatch({ type: "rooms_loaded", rooms: listing.rooms });
				if (current) setRechecked(true);
			},
			() => {
				if (current) setRechecked(true);
			},
		);
		return () => {
			current = false;
		};
	}, [unknown, rechecked]);

	if (unknown && rechecked)
		return (
			<section className="room">
				<div className="page">
					<Empty>{t("This room is not available.")}</Empty>
					<a className="back" href={hrefFor("rooms")}>
						{t("Back to rooms")}
					</a>
				</div>
			</section>
		);

	const name = view?.displayName ?? roomKey;
	const lastAgent = [...(room?.messages ?? [])]
		.reverse()
		.find((m) => m.kind === "agent");
	const mine = room?.mode;
	const agentName = view?.kind === "agent" ? view.name : undefined;
	const parent = view?.kind === "thread" ? view.parent : undefined;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: dropping files on the room attaches them; the paperclip is the keyboard path
		<section
			className="room"
			style={accent}
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes("Files")) event.preventDefault();
			}}
			onDrop={(event) => {
				if (!event.dataTransfer.files.length) return;
				event.preventDefault();
				setDropped([...event.dataTransfer.files]);
			}}
		>
			<header className="room-head">
				<a
					className="icon-button room-back"
					href={hrefFor("rooms")}
					aria-label={t("Back to rooms")}
				>
					<Icon name="back" />
				</a>
				{view?.kind === "group" ? (
					<CharacterStack
						size={36}
						members={(view.members ?? []).map((member) => ({
							name: member,
							spec: characters[member],
						}))}
					/>
				) : (
					<PageCharacter
						spec={character}
						name={parentView?.name ?? view?.name ?? name}
						size={44}
						state={state}
						label={name}
					/>
				)}
				<div className="room-title">
					<h1>{name}</h1>
					<span
						className="room-status"
						data-working={room?.typing || undefined}
					>
						{view?.kind === "thread"
							? view.closed
								? t("Thread · finished")
								: room?.typing
									? t("Working…")
									: t("Thread · read-only")
							: view?.readOnly
								? t("Read-only")
								: room?.typing
									? t("Working…")
									: view?.kind === "group"
										? t("Group")
										: view?.home
											? t("Home")
											: t("Idle")}
					</span>
				</div>
				{view?.kind === "group" ? (
					<GroupTable roomKey={roomKey} slot={tableSlot} />
				) : null}
				<button
					ref={menuButton}
					type="button"
					className="icon-button"
					aria-label={t("Room menu")}
					aria-haspopup="dialog"
					onClick={() => setMenu(true)}
				>
					<Icon name="menu" />
				</button>
			</header>
			<div className="room-table-slot" ref={setTableSlot} />
			{!open ? (
				<div className="offline-banner" role="status">
					<span className="spinner" aria-hidden="true" />
					{t("Reconnecting… messages wait here until it is back.")}
				</div>
			) : null}
			<ModeBanner
				room={roomKey}
				mode={mine && (mine.yolo || mine.longRunning) ? mine : undefined}
				approved={room?.autoApproved ?? 0}
			/>
			<div className="room-scroll" ref={scroller} onScroll={onScroll}>
				<div className="room-content" ref={content}>
					{error ? <Failure message={error} /> : null}
					{!loaded && !error ? (
						<div className="stack" aria-busy="true">
							<div className="skeleton" />
							<div className="skeleton" />
						</div>
					) : null}
					{room?.more ? (
						<button
							type="button"
							className="secondary older"
							disabled={loadingOlder}
							onClick={loadOlder}
						>
							{loadingOlder ? t("Loading…") : t("Load earlier messages")}
						</button>
					) : null}
					{loaded && items.length === 0 ? (
						<Empty>{t("No messages yet. Say hello.")}</Empty>
					) : null}
					<ol className="messages">
						{rows.map((row) => {
							switch (row.item.kind) {
								case "message":
									return (
										<RowFragment key={`m${row.item.message.id}`} day={row.day}>
											<MessageRow
												message={row.item.message}
												character={
													row.item.message.agent
														? characters[row.item.message.agent]
														: undefined
												}
												header={row.header}
												enter={
													mountedLast.current !== undefined &&
													row.item.message.id > mountedLast.current
												}
												timeZone={config.timeZone}
											/>
										</RowFragment>
									);
								case "card":
									return (
										<li key={`c${row.item.id}`} className="slot" data-enter>
											<PromptCard card={row.item.card} />
										</li>
									);
								case "pending":
									return (
										<PendingRow
											key={`p${row.item.pending.id}`}
											pending={row.item.pending}
										/>
									);
								case "live":
									return (
										<LiveRow
											key={`l${row.item.message.live}`}
											message={row.item.message}
											character={
												row.item.message.agent
													? characters[row.item.message.agent]
													: undefined
											}
										/>
									);
								default:
									return null;
							}
						})}
					</ol>
					{room?.typing ? (
						<ProgressStrip
							name={lastAgent?.author ?? name}
							progress={room.progress}
						/>
					) : null}
				</div>
			</div>
			{away ? (
				<button type="button" className="to-end" onClick={() => toEnd(true)}>
					<Icon name="send" size={16} style={{ transform: "rotate(180deg)" }} />
					{t("Latest")}
				</button>
			) : null}
			{view?.readOnly ? (
				<p className="room-note">
					{t(
						"This is a dispatch thread. It shows what was sent and answered; reply in its parent room.",
					)}{" "}
					{parent ? (
						<a href={hrefFor("room", parent)}>{t("Open the parent room")}</a>
					) : null}
				</p>
			) : (
				<Composer
					key={roomKey}
					name={name}
					limits={limits}
					stoppable={Boolean(room?.stoppable)}
					onSend={(text, files) => {
						connection.say(roomKey, text, files);
						toEnd(true);
					}}
					onStop={() => connection.send({ type: "stop", room: roomKey })}
					{...(dropped
						? {
								incoming: dropped,
								onIncomingTaken: () => setDropped(undefined),
							}
						: {})}
				/>
			)}
			<RoomMenu
				open={menu}
				room={roomKey}
				mode={mine}
				agent={agentName}
				readOnly={view?.readOnly ?? false}
				parent={parent}
				onClose={() => setMenu(false)}
				onAskYolo={() => {
					setMenu(false);
					setConfirm("yolo");
				}}
				onAskStartOver={() => {
					setMenu(false);
					setConfirm("start-over");
				}}
			/>
			<Confirm
				open={confirm === "yolo"}
				title={t("Turn on yolo mode?")}
				confirmLabel={t("Turn on yolo mode")}
				tone="yolo"
				restoreFocus={() => menuButton.current}
				onClose={() => setConfirm(undefined)}
				onConfirm={async () => {
					await api.setMode(roomKey, { yolo: true });
				}}
			>
				<p>
					{t(
						"In this room, the agent's held actions are approved for you, without a card, as soon as they come up.",
					)}
				</p>
				<p>
					{t(
						"Risky classes still ask: running as another user, deleting files, force pushes, disk, service and firewall changes, and anything that names its own approvers. The host can add more.",
					)}
				</p>
				<p>
					{t(
						"Every approval it makes is written into the conversation, and a banner stays up while yolo mode is on.",
					)}
				</p>
			</Confirm>
			<Confirm
				open={confirm === "start-over"}
				title={t("Start over {name}?", { name })}
				confirmLabel={t("Start over")}
				tone="danger"
				restoreFocus={() => menuButton.current}
				onClose={() => setConfirm(undefined)}
				onConfirm={async () => {
					await api.startRoomOver(roomKey);
				}}
			>
				<p>
					{t(
						"The current conversation is archived and the next message begins a new one. Long-term memory is kept. A turn that is running finishes first.",
					)}
				</p>
			</Confirm>
		</section>
	);
}

interface Row {
	item: TimelineItem;
	header: boolean;
	day: string | undefined;
}

/** The timeline with, for each stored message, whether it shows its author and whether a new day starts at it. */
function useRows(
	items: TimelineItem[],
	timeZone: string,
	now: number,
	headerOf: (message: RoomMessage, before: RoomMessage | undefined) => boolean,
): Row[] {
	// biome-ignore lint/correctness/useExhaustiveDependencies: `headerOf` only closes over constants
	return useMemo(() => {
		let before: RoomMessage | undefined;
		let lastDay: string | undefined;
		return items.map((item) => {
			if (item.kind !== "message")
				return { item, header: true, day: undefined };
			const day = dayKey(item.message.at, timeZone);
			const starts =
				day !== lastDay ? dayLabel(item.message.at, now, timeZone) : undefined;
			lastDay = day;
			const header = headerOf(item.message, before) || starts !== undefined;
			before = item.message;
			return { item, header, day: starts };
		});
	}, [items, timeZone, now]);
}

/** A message with the day's label above it when a new day starts there. */
function RowFragment(props: {
	day: string | undefined;
	children: React.ReactNode;
}) {
	return (
		<>
			{props.day ? (
				<li className="day" aria-hidden="true">
					<span>{props.day}</span>
				</li>
			) : null}
			{props.children}
		</>
	);
}
