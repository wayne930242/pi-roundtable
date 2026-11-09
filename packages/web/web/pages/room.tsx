import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { PageCharacter } from "../components/character.tsx";
import { Composer } from "../components/composer.tsx";
import { HeaderPicture } from "../components/header-picture.tsx";
import { Icon } from "../components/icons.tsx";
import { ModeBanner } from "../components/mode-banner.tsx";
import { RoomChat } from "../components/room-chat.tsx";
import { Empty, Loading } from "../components/states.tsx";
import { RoomSwitcher, useSwitcher } from "../components/switcher.tsx";
import { WaitingButton } from "../components/waiting-button.tsx";
import { openAgentSheet } from "../lib/agent-sheet.ts";
import { api } from "../lib/api.ts";
import { store, useSelector } from "../lib/app-store.ts";
import { useAccentStyle, useRoomState } from "../lib/characters.ts";
import { chatsHome } from "../lib/home-mode.ts";
import { useMedia } from "../lib/media.ts";
import { withoutLeadingAiMention } from "../lib/mention.ts";
import { translate as t } from "../lib/messages.ts";
import { useRoomCommands } from "../lib/room-commands.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { hrefFor, navigate } from "../lib/router.ts";
import { useConnection } from "../lib/socket.ts";

// A group room is a council: its view, with the round table's drawing, is read only when one opens.
const CouncilView = lazy(() =>
	import("../components/council-view.tsx").then((m) => ({
		default: m.CouncilView,
	})),
);

// The composer's @AI switch, and the styles it brings, are read only in a room that takes notes.
const ModeToggle = lazy(() =>
	import("../components/mode-toggle.tsx").then((m) => ({
		default: m.ModeToggle,
	})),
);

// The control for a room's threads is read only where the home is the chat list.
const RoomThreadsButton = lazy(() =>
	import("../components/room-threads.tsx").then((m) => ({
		default: m.RoomThreadsButton,
	})),
);

// The room's menu is read only when it is opened.
const RoomMenu = lazy(() =>
	import("../components/room-menu.tsx").then((m) => ({ default: m.RoomMenu })),
);

export function RoomPage({ roomKey }: { roomKey: string }) {
	const connection = useConnection();
	const room = useSelector((state) => state.rooms[roomKey]);
	const listed = useSelector((state) => state.listed);
	const open = useSelector((state) => state.connection === "open");
	const limits = useSelector((state) => state.limits);
	const rooms = useSelector((state) => state.rooms);
	const state = useRoomState(roomKey);
	const view = room?.view;
	const commands = useRoomCommands(
		roomKey,
		view?.displayName ?? roomKey,
		view?.kind === "agent" && !view.readOnly,
	);
	// A dispatch thread has no character of its own; it wears its parent room's.
	const parentView = view?.parent ? rooms[view.parent]?.view : undefined;
	const character = view?.character ?? parentView?.character;
	const accent = useAccentStyle(character);
	const [menu, setMenu] = useState(false);
	/** The menu has been opened once, so its code is wanted. */
	const [menuOpened, setMenuOpened] = useState(false);
	const [dropped, setDropped] = useState<File[]>();
	/** The room where the person turned @AI off, to leave notes; every room opens with it on. */
	const [noting, setNoting] = useState<string>();
	/** The person typed `@AI` at the start of the box: where notes are on offer, the message goes to the agent whatever the switch says. */
	const [addressed, setAddressed] = useState(false);
	const menuButton = useRef<HTMLButtonElement>(null);
	// Beside the room list (wide screens) the room needs no drawer; elsewhere a swipe right brings one.
	const switcher = useSwitcher(!useMedia("(min-width: 1024px)"));

	// The page shows this room, so its progress streams here.
	useEffect(() => {
		connection.focus(roomKey);
		return () => connection.focus(undefined);
	}, [connection, roomKey]);

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
					hidden: chatsHome() ? listing.hidden : [],
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
	const mine = room?.mode;
	const agentName = view?.kind === "agent" ? view.name : undefined;
	const parent = view?.kind === "thread" ? view.parent : undefined;
	// Where more than one person reads the room, a message can be a note for them that the agent does not get.
	const toggled = view?.notes === true;
	const mentioned = toggled && addressed;
	const note = toggled && noting === roomKey && !mentioned;
	const lead = (
		<>
			<a
				className="icon-button room-back"
				href={hrefFor("rooms")}
				aria-label={t("Back to rooms")}
			>
				<Icon name="back" />
			</a>
			<HeaderPicture open={switcher.enabled ? switcher.show : undefined}>
				<PageCharacter
					spec={character}
					name={parentView?.name ?? view?.name ?? name}
					size={44}
					state={state}
					label={name}
				/>
			</HeaderPicture>
			<div className="room-title">
				<h1>
					{agentName ? (
						<button
							type="button"
							className="room-name"
							aria-haspopup="dialog"
							title={t("Edit knight")}
							onClick={() => openAgentSheet(agentName)}
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
				<span className="room-status" data-working={room?.typing || undefined}>
					{view?.helper ? (
						<>
							{t("Temp knight")} ·{" "}
							<a href={hrefFor("room", view.helper.parent)}>
								{t("Made by {name}", { name: view.helper.parentName })}
							</a>
						</>
					) : view?.kind === "thread" ? (
						view.closed ? (
							t("Thread · finished")
						) : room?.typing ? (
							t("Working…")
						) : (
							t("Thread · read-only")
						)
					) : view?.readOnly ? (
						t("Read-only")
					) : room?.typing ? (
						t("Working…")
					) : view?.home ? (
						t("Home")
					) : (
						t("Idle")
					)}
				</span>
			</div>
		</>
	);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: dropping files on the room attaches them; the paperclip is the keyboard path
		<section
			className="room"
			style={accent}
			{...switcher.surface}
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes("Files")) event.preventDefault();
			}}
			onDrop={(event) => {
				if (!event.dataTransfer.files.length) return;
				event.preventDefault();
				setDropped([...event.dataTransfer.files]);
			}}
		>
			{view?.kind === "group" ? (
				<Suspense fallback={<Loading />}>
					<CouncilView
						roomKey={roomKey}
						room={{ drawer: switcher.enabled ? switcher.show : undefined }}
						go={(council) => navigate("room", council.key, { replace: true })}
						incoming={dropped}
						onIncomingTaken={() => setDropped(undefined)}
					/>
				</Suspense>
			) : (
				<>
					<header className="room-head">
						{lead}
						<WaitingButton />
						{chatsHome() ? (
							<Suspense fallback={null}>
								<RoomThreadsButton room={roomKey} />
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
					<RoomChat
						roomKey={roomKey}
						name={name}
						composer={(toEnd) =>
							view?.readOnly ? (
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
									commands={commands}
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
									onStop={() =>
										connection.send({ type: "stop", room: roomKey })
									}
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
							)
						}
					/>
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
