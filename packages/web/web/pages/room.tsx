import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CharacterStack, PageCharacter } from "../components/character.tsx";
import { Composer } from "../components/composer.tsx";
import { Icon } from "../components/icons.tsx";
import { ModeBanner } from "../components/mode-banner.tsx";
import { ProgressStrip } from "../components/progress-strip.tsx";
import {
	loadOlderMessages,
	RoomLog,
	useRoomHistory,
} from "../components/room-log.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { RoomSwitcher, useSwitcher } from "../components/switcher.tsx";
import { openAgentSheet } from "../lib/agent-sheet.ts";
import { api } from "../lib/api.ts";
import { store, useSelector } from "../lib/app-store.ts";
import {
	useAccentStyle,
	useCharacters,
	useRoomState,
} from "../lib/characters.ts";
import { hostUi } from "../lib/frame-taps.ts";
import { useMedia } from "../lib/media.ts";
import { withoutLeadingAiMention } from "../lib/mention.ts";
import { translate as t } from "../lib/messages.ts";
import { reducedMotion } from "../lib/motion.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { timeline } from "../lib/rooms.ts";
import { hrefFor } from "../lib/router.ts";
import { useConnection } from "../lib/socket.ts";
import { useTableMode } from "../lib/table-mode.ts";
import { openTeamSheet } from "../lib/team-sheet.ts";

// A group room's table strip is read only when a group room opens: it carries the round table's drawing.
const GroupTable = lazy(() =>
	import("../components/group-table.tsx").then((m) => ({
		default: m.GroupTable,
	})),
);

// The scene a group room can switch to is read only when it is first shown, with the dialogue box and the table.
const GroupScene = lazy(() =>
	import("../components/group-scene.tsx").then((m) => ({
		default: m.GroupScene,
	})),
);

// The read marks and the divider of new messages load beside the log; until they do the log shows as it is.
const ReadLog = lazy(() => hostUi().then((ui) => ({ default: ui.ReadLog })));

// The composer's @AI switch, and the styles it brings, are read only in a room that takes notes.
const ModeToggle = lazy(() =>
	import("../components/mode-toggle.tsx").then((m) => ({
		default: m.ModeToggle,
	})),
);

// The room's menu is read only when it is opened.
const RoomMenu = lazy(() =>
	import("../components/room-menu.tsx").then((m) => ({ default: m.RoomMenu })),
);

/**
 * Keeps the end of the list in view while the person is at the end, and says when more arrived
 * while they were not. A scroll event caused by the content growing is not the person moving, so
 * only scrolls that leave the height as it was count as theirs.
 */
export function useStickToEnd(
	scroller: React.RefObject<HTMLDivElement | null>,
) {
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
	const room = useSelector((state) => state.rooms[roomKey]);
	const listed = useSelector((state) => state.listed);
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
	const { loaded, error } = useRoomHistory(roomKey);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [menu, setMenu] = useState(false);
	/** The menu has been opened once, so its code is wanted. */
	const [menuOpened, setMenuOpened] = useState(false);
	/** Under the header: where a group's table strip and panel go. */
	const [tableSlot, setTableSlot] = useState<HTMLDivElement | null>(null);
	const [dropped, setDropped] = useState<File[]>();
	/** The room where the person turned @AI off, to leave notes; every room opens with it on. */
	const [noting, setNoting] = useState<string>();
	/** The person typed `@AI` at the start of the box: where notes are on offer, the message goes to the agent whatever the switch says. */
	const [addressed, setAddressed] = useState(false);
	const [scene, setScene] = useTableMode(roomKey);
	const inScene = view?.kind === "group" && scene;
	const menuButton = useRef<HTMLButtonElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { away, onScroll, onGrow, toEnd } = useStickToEnd(scroller);
	// Beside the room list (wide screens) the room needs no drawer; elsewhere a swipe right brings one.
	const switcher = useSwitcher(!useMedia("(min-width: 1024px)"));
	const mountedLast = useRef<number | undefined>(undefined);
	const prepend = useRef<number | undefined>(undefined);

	// The page shows this room, so its progress streams here.
	useEffect(() => {
		connection.focus(roomKey);
		return () => connection.focus(undefined);
	}, [connection, roomKey]);

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
		const done = await loadOlderMessages(roomKey);
		if (!done) prepend.current = undefined;
		setLoadingOlder(false);
	};

	// A thread's link can arrive before the room list does; ask for the list once before giving up.
	const [rechecked, setRechecked] = useState(false);
	const unknown = listed && !view;
	useEffect(() => {
		if (!unknown || rechecked) return;
		let current = true;
		const recheck = async () => {
			try {
				const listing = await api.rooms();
				store.dispatch({
					type: "rooms_loaded",
					rooms: listing.rooms,
					pins: listing.pins,
					folders: listing.folders,
				});
				// A thread dismissed from the list is not in it and still opens by its address.
				if (!listing.rooms.some((one) => one.key === roomKey))
					store.dispatch({
						type: "room_viewed",
						view: (await api.room(roomKey)).room,
					});
			} catch {
				// The room stays unavailable.
			}
			if (current) setRechecked(true);
		};
		recheck();
		return () => {
			current = false;
		};
	}, [unknown, rechecked, roomKey]);

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
	const log = {
		roomKey,
		enterAfter: mountedLast.current,
		quotable: !view?.readOnly,
	};
	const lastAgent = [...(room?.messages ?? [])]
		.reverse()
		.find((m) => m.kind === "agent");
	const mine = room?.mode;
	const agentName = view?.kind === "agent" ? view.name : undefined;
	const groupName = view?.kind === "group" ? view.name : undefined;
	const parent = view?.kind === "thread" ? view.parent : undefined;
	// Where more than one person reads the room, a message can be a note for them that the agent does not get.
	const toggled = view?.notes === true;
	const mentioned = toggled && addressed;
	const note = toggled && noting === roomKey && !mentioned;
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
				<HeaderPicture open={switcher.enabled ? switcher.show : undefined}>
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
				</HeaderPicture>
				<div className="room-title">
					<h1>
						{agentName || groupName ? (
							<button
								type="button"
								className="room-name"
								aria-haspopup="dialog"
								title={agentName ? t("Edit knight") : t("Edit group")}
								onClick={() =>
									agentName
										? openAgentSheet(agentName)
										: groupName &&
											openTeamSheet({ kind: "group", name: groupName })
								}
							>
								{name}
							</button>
						) : (
							name
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
					<Suspense fallback={null}>
						<GroupTable
							roomKey={roomKey}
							slot={tableSlot}
							scene={scene}
							onScene={setScene}
						/>
					</Suspense>
				) : null}
				<button
					ref={menuButton}
					type="button"
					className="icon-button"
					aria-label={t("Room menu")}
					aria-haspopup="dialog"
					onClick={() => {
						setMenuOpened(true);
						setMenu(true);
					}}
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
			{inScene ? (
				<Suspense fallback={<Loading />}>
					<GroupScene roomKey={roomKey} members={view?.members ?? []} />
				</Suspense>
			) : (
				<>
					<div
						className="room-scroll"
						ref={scroller}
						onScroll={onScroll}
						{...switcher.surface}
					>
						<div className="room-content" ref={content}>
							{error ? <Failure message={error} /> : null}
							{!loaded && !error ? <Loading /> : null}
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
							<Suspense fallback={<RoomLog {...log} />}>
								<ReadLog {...log} scroller={scroller} />
							</Suspense>
							{room?.typing ? (
								<ProgressStrip
									name={lastAgent?.author ?? name}
									progress={room.progress}
								/>
							) : null}
						</div>
					</div>
					{away ? (
						<button
							type="button"
							className="to-end"
							onClick={() => toEnd(true)}
						>
							<Icon
								name="send"
								size={16}
								style={{ transform: "rotate(180deg)" }}
							/>
							{t("Latest")}
						</button>
					) : null}
					{view?.readOnly ? (
						<p className="room-note">
							{t(
								"This is a dispatch thread. It shows what was sent and answered; reply in its parent room.",
							)}{" "}
							{parent ? (
								<a href={hrefFor("room", parent)}>
									{t("Open the parent room")}
								</a>
							) : null}
						</p>
					) : (
						<Composer
							key={roomKey}
							draftKey={roomKey}
							name={name}
							onAddressed={setAddressed}
							{...(toggled
								? {
										placeholder: note
											? t("Write an internal note…")
											: t("Ask AI…"),
										above: (
											<Suspense fallback={null}>
												<ModeToggle
													on={!note}
													label={t("@AI")}
													{...(mentioned
														? {
																locked: t(
																	"The message starts with @AI, so the knight answers.",
																),
															}
														: {})}
													onChange={(next) =>
														setNoting(next ? undefined : roomKey)
													}
												/>
											</Suspense>
										),
									}
								: {})}
							limits={limits}
							stoppable={Boolean(room?.stoppable)}
							onSend={(text, files, typedAt) => {
								if (toggled && typedAt) {
									// Without the token the message may be empty; then it goes as it was typed.
									const body = withoutLeadingAiMention(text);
									connection.say(
										roomKey,
										body === "" && files.length === 0 ? text : body,
										files,
										"turn",
									);
								} else
									connection.say(
										roomKey,
										text,
										files,
										note ? "note" : undefined,
									);
								toEnd(true);
							}}
							onStop={() => connection.send({ type: "stop", room: roomKey })}
							{...(view?.kind === "group"
								? { stopLabel: t("Stop the round") }
								: {})}
							{...(dropped
								? {
										incoming: dropped,
										onIncomingTaken: () => setDropped(undefined),
									}
								: {})}
						/>
					)}
				</>
			)}
			{menuOpened ? (
				<Suspense fallback={null}>
					<RoomMenu
						open={menu}
						room={roomKey}
						mode={mine}
						muted={view?.muted === true}
						agent={agentName}
						group={groupName}
						coordinator={view?.coordinator === true}
						displayName={name}
						readOnly={view?.readOnly ?? false}
						parent={parent}
						onClose={() => setMenu(false)}
						onAskYolo={() => {
							setMenu(false);
							askRoomConfirm({
								kind: "yolo",
								room: roomKey,
								name,
								restoreFocus: () => menuButton.current,
							});
						}}
						onAskStartOver={() => {
							setMenu(false);
							askRoomConfirm({
								kind: "start-over",
								room: roomKey,
								name,
								restoreFocus: () => menuButton.current,
							});
						}}
					/>
				</Suspense>
			) : null}
			<RoomSwitcher {...switcher.drawer} current={roomKey} />
		</section>
	);
}

/** The room's picture in the header; where the room has a drawer, tapping it opens the drawer. */
function HeaderPicture(props: {
	open: (() => void) | undefined;
	children: React.ReactNode;
}) {
	if (!props.open) return props.children;
	return (
		<button
			type="button"
			className="room-picture"
			aria-label={t("Switch rooms")}
			aria-haspopup="dialog"
			onClick={props.open}
		>
			{props.children}
		</button>
	);
}
