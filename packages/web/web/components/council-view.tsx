import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
import type { RoomView } from "../../src/api-types.ts";
import { openMenu } from "../lib/action-menu.ts";
import { useSelector } from "../lib/app-store.ts";
import { useCouncilMode } from "../lib/council-mode.ts";
import { mentionInto } from "../lib/drafts.ts";
import type { Via } from "../lib/long-press.ts";
import { useLook } from "../lib/look.ts";
import { useMedia } from "../lib/media.ts";
import { withoutLeadingAiMention } from "../lib/mention.ts";
import { seatMenuOf } from "../lib/menus.ts";
import { translate as t } from "../lib/messages.ts";
import { useRoomCommands } from "../lib/room-commands.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { useConnection } from "../lib/socket.ts";
import { installTablePageStyle } from "../lib/table-page-style.ts";
import type { SeatMenuRequest, TableHandle } from "../table/entry.ts";
import { Composer } from "./composer.tsx";
import { CouncilHead } from "./council-head.tsx";
import type { CouncilGo } from "./council-sheet.tsx";
import { GroupStage, useGroupFocus } from "./group-scene.tsx";
import { ModeBanner } from "./mode-banner.tsx";
import { RoomChat } from "./room-chat.tsx";
import { RoundTable, useRoster } from "./round-table.tsx";

installTablePageStyle();

// Who sits is chosen in a sheet that loads when it is first asked for.
const CouncilSheet = lazy(() =>
	import("./council-sheet.tsx").then((m) => ({ default: m.CouncilSheet })),
);

// The composer's @AI switch, and the styles it brings, are read only in a room that takes notes.
const ModeToggle = lazy(() =>
	import("./mode-toggle.tsx").then((m) => ({ default: m.ModeToggle })),
);

// The room's menu is read only when it is opened.
const RoomMenu = lazy(() =>
	import("./room-menu.tsx").then((m) => ({ default: m.RoomMenu })),
);

/** Opens the menu of a council member's seat; its builder loads with the first menu. */
function openSeatMenu(
	key: string,
	council: string,
	at: SeatMenuRequest["at"],
	via: Via,
	source: HTMLElement | null,
): void {
	seatMenuOf(key, council).then(
		(spec) => {
			if (spec) openMenu({ ...spec, at, via, source });
		},
		() => undefined,
	);
}

/** A phone's screen, narrow or touched: a message sent from the council closes its keyboard, so the answer has the screen. */
export function usePhone(): boolean {
	const narrow = useMedia("(max-width: 719px)");
	const touch = useMedia("(pointer: coarse)");
	return narrow || touch;
}

/** The council sheet, mounted when first asked for and kept, so it can slide away; `ask` opens it. */
export function useCouncilSheet(council: RoomView | undefined, go?: CouncilGo) {
	const [asked, setAsked] = useState(false);
	const [open, setOpen] = useState(false);
	const ask = () => {
		setAsked(true);
		setOpen(true);
	};
	const sheet = asked ? (
		<Suspense fallback={null}>
			<CouncilSheet
				open={open}
				onClose={() => setOpen(false)}
				council={council}
				{...(go ? { go } : {})}
			/>
		</Suspense>
	) : null;
	return { ask, sheet };
}

/**
 * A group's council, the one shell the group's room and the round table both show. The header is
 * `CouncilHead`, the same in both entries: the council's picture and name, the button that brings
 * the camera back to the whole ring, the switch between the scene and the chat (kept per council
 * room, the same in both entries), the waiting cards and the room menu; under it the room's
 * banners. The body is the scene with its dialogue box, or the room's messages as a chat with its
 * composer, a compact strip of the members over it under Camelot. On a phone a message sent
 * closes the keyboard.
 */
export function CouncilView(props: {
	roomKey: string;
	/** The group's room, which has a way back and a drawer; absent on the round table, whose header name picks the council. */
	room?: { drawer: (() => void) | undefined };
	/** Where a council picked in the sheet goes. */
	go?: CouncilGo;
	/** What stands in the body when no member is left to seat; without it the room still shows. */
	empty?: ReactNode;
	/** Files dropped on the page, for the chat's composer to take. */
	incoming?: File[] | undefined;
	onIncomingTaken?(): void;
}) {
	const { roomKey } = props;
	const connection = useConnection();
	const room = useSelector((state) => state.rooms[roomKey]);
	const open = useSelector((state) => state.connection === "open");
	const limits = useSelector((state) => state.limits);
	const look = useLook();
	const phone = usePhone();
	const view = room?.view;
	const members = view?.members ?? [];
	const roster = useRoster(members);
	const [mode, setMode] = useCouncilMode(roomKey);
	const [table, setTable] = useState<TableHandle>();
	const { focus, look: turn } = useGroupFocus(roomKey, members);
	const { ask, sheet } = useCouncilSheet(view, props.go);
	const [menu, setMenu] = useState(false);
	/** The menu has been opened once, so its code is wanted. */
	const [menuOpened, setMenuOpened] = useState(false);
	const menuButton = useRef<HTMLButtonElement>(null);
	/** The room where the person turned @AI off, to leave notes; every room opens with it on. */
	const [noting, setNoting] = useState<string>();
	/** The person typed `@AI` at the start of the box: where notes are on offer, the message goes to the agent whatever the switch says. */
	const [addressed, setAddressed] = useState(false);

	// The council's room streams its progress here, in either mode.
	useEffect(() => {
		connection.focus(roomKey);
		return () => connection.focus(undefined);
	}, [connection, roomKey]);

	const name = view?.displayName ?? roomKey;
	const commands = useRoomCommands(roomKey, name, false);
	const mine = room?.mode;
	const seated = roster.length > 0 || props.empty === undefined;
	const scene = seated && mode === "scene";
	// Where more than one person reads the room, a message can be a note for them that the agent does not get.
	const toggled = view?.notes === true;
	const mentioned = toggled && addressed;
	const note = toggled && noting === roomKey && !mentioned;
	return (
		<>
			<CouncilHead
				view={view}
				name={name}
				working={room?.typing === true}
				room={props.room}
				onPick={ask}
				onReset={
					scene && table?.kind === "webgl" ? () => turn(null) : undefined
				}
				mode={seated ? mode : undefined}
				onMode={setMode}
				menuButton={menuButton}
				onMenu={() => {
					setMenuOpened(true);
					setMenu(true);
				}}
			/>
			{look === "camelot" && seated && !scene ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: a pointer press on a podium must not take the focus off the message box, where the mention lands; the podiums stay buttons for the keyboard
				<div
					className="group-strip"
					onMouseDown={(event) => event.preventDefault()}
				>
					<RoundTable
						members={members}
						groupRoom={roomKey}
						variant="compact"
						onSeat={(member) => {
							const one = roster.find((seat) => seat.name === member);
							if (one) mentionInto(roomKey, one.displayName);
						}}
						onSeatMenu={(request: SeatMenuRequest) => {
							const one = roster.find((seat) => seat.name === request.id);
							if (one)
								openSeatMenu(
									one.key,
									roomKey,
									request.at,
									request.via,
									request.source,
								);
						}}
					/>
				</div>
			) : null}
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
			{!seated ? (
				<div className="table-frame">{props.empty}</div>
			) : scene ? (
				<GroupStage
					roomKey={roomKey}
					members={members}
					focus={focus}
					onLook={turn}
					blurAfterSend={phone}
					onHandle={setTable}
					onSeatMenu={(request: SeatMenuRequest) => {
						const one = roster.find((seat) => seat.name === request.id);
						if (one)
							openSeatMenu(
								one.key,
								roomKey,
								request.at,
								request.via,
								request.source,
							);
					}}
				/>
			) : (
				<div className="table-chat">
					<RoomChat
						roomKey={roomKey}
						name={name}
						composer={(toEnd) =>
							view?.readOnly ? null : (
								<Composer
									key={roomKey}
									draftKey={roomKey}
									mentionable={roster}
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
									stopLabel={t("Stop the round")}
									blurAfterSend={phone}
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
									{...(props.incoming && props.onIncomingTaken
										? {
												incoming: props.incoming,
												onIncomingTaken: props.onIncomingTaken,
											}
										: {})}
								/>
							)
						}
					/>
				</div>
			)}
			{sheet}
			{menuOpened ? (
				<Suspense fallback={null}>
					<RoomMenu
						open={menu}
						room={roomKey}
						mode={mine}
						muted={view?.muted === true}
						agent={undefined}
						group={view?.name}
						coordinator={view?.coordinator === true}
						displayName={name}
						readOnly={view?.readOnly ?? false}
						parent={undefined}
						onClose={() => setMenu(false)}
						onEditCouncil={ask}
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
		</>
	);
}
