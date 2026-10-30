import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useReducer,
	useRef,
	useState,
} from "react";
import type { RoomView } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { useAccentStyle, useCharacters } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import {
	boxCards,
	createReveal,
	currentLine,
	type Line,
	sliceChars,
} from "../lib/dialogue.ts";
import { translate as t } from "../lib/messages.ts";
import { reducedMotion } from "../lib/motion.ts";
import type { RoomState } from "../lib/rooms.ts";
import { useConnection } from "../lib/socket.ts";
import { PromptCard } from "./cards.tsx";
import { PageCharacter } from "./character.tsx";
import { Composer } from "./composer.tsx";
import { Icon } from "./icons.tsx";
import { MessageMarkdown } from "./message-markdown.tsx";
import { Files } from "./message-row.tsx";
import { ProgressStrip } from "./progress-strip.tsx";
import { loadOlderMessages, RoomLog, useRoomHistory } from "./room-log.tsx";
import { Sheet } from "./sheet.tsx";

/**
 * Drives a line's reveal: the words come one by one as they stream, a tap shows them all, and
 * reduced motion shows them whole at once. Returns the characters showing and whether all of them do.
 */
function useReveal(line: Line | undefined): {
	shown: number;
	done: boolean;
	finish(): void;
} {
	const reveal = useRef(createReveal());
	const [, redraw] = useReducer((count: number) => count + 1, 0);
	const instant = reducedMotion();
	reveal.current.feed(line?.id ?? "", line?.text ?? "");
	// A line that arrived whole (a stored message the page has not seen being written) types out too; one a reload brought does not wait.
	const text = line?.text ?? "";
	const lineId = line?.id;
	useEffect(() => {
		const current = reveal.current;
		if (instant || text === "" || lineId === undefined) {
			current.finish();
			redraw();
			return;
		}
		let last = performance.now();
		let frame = 0;
		const tick = () => {
			const now = performance.now();
			current.step(now - last, false);
			last = now;
			redraw();
			if (!current.done) frame = requestAnimationFrame(tick);
		};
		if (!current.done) frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [instant, lineId, text]);
	return {
		shown: reveal.current.shown,
		done: reveal.current.done,
		finish() {
			reveal.current.finish();
			redraw();
		},
	};
}

/** The newest line of a room, with the room's state and view: what the box shows, and what a group scene follows. */
export function useRoomLine(roomKey: string): {
	room: RoomState | undefined;
	view: RoomView | undefined;
	line: Line | undefined;
} {
	const room = useSelector((state) => state.rooms[roomKey]);
	const ownerName = useSelector((state) => state.principal?.name) ?? t("You");
	/** Each agent's name to show, by name. */
	const names = useSelector((state) => {
		const found: Record<string, string> = {};
		for (const one of Object.values(state.rooms))
			if (one.view?.kind === "agent")
				found[one.view.name] = one.view.displayName;
		return found;
	});
	const view = room?.view;
	const displayOf = (name: string | undefined): string =>
		(name === undefined ? undefined : names[name]) ??
		name ??
		view?.displayName ??
		roomKey;
	const line = currentLine(
		room,
		ownerName,
		displayOf,
		view?.kind === "agent" ? view.name : undefined,
	);
	return { room, view, line };
}

/** The sheet that holds the room's whole message list, over the scene. */
function LogSheet(props: {
	roomKey: string;
	open: boolean;
	loaded: boolean;
	error: string | undefined;
	onClose(): void;
	name: string;
}) {
	const { loaded, error } = props;
	const room = useSelector((state) => state.rooms[props.roomKey]);
	const [older, setOlder] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	// Opening the log lands on the newest.
	useEffect(() => {
		if (props.open && loaded)
			scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [props.open, loaded]);
	return (
		<Sheet
			open={props.open}
			title={`${props.name} · ${t("Log")}`}
			onClose={props.onClose}
		>
			<div className="scene-log" ref={scroller}>
				{error ? <p className="failure-text">{error}</p> : null}
				{room?.more ? (
					<button
						type="button"
						className="secondary older"
						disabled={older}
						onClick={async () => {
							setOlder(true);
							await loadOlderMessages(props.roomKey);
							setOlder(false);
						}}
					>
						{older ? t("Loading…") : t("Load earlier messages")}
					</button>
				) : null}
				<RoomLog roomKey={props.roomKey} enterAfter={undefined} quotable />
			</div>
		</Sheet>
	);
}

export interface DialogueBoxProps {
	/** The room the box speaks in: an agent's own, or the group's. */
	roomKey: string;
	/** Slid up (the camera has arrived) or down (the camera is on its way, or away). */
	open: boolean;
	/** The page streams the room's progress to this box; false where the room's own page already does. */
	streams?: boolean;
	/** Goes back to the whole ring; the box offers it as a button when given. */
	onBack?: (() => void) | undefined;
	/** Opens the box's menu from its ⋯ button, given the button; no button when absent. */
	onMenu?: ((anchor: HTMLElement) => void) | undefined;
	/** What stands under the nameplate, over the line: a group's order strip. */
	strip?: ReactNode;
}

/**
 * The scene's dialogue box, a page overlay and not part of the picture: a nameplate tab in the
 * speaker's colour with their picture, the line being said (Markdown, typed out while it streams, a tap
 * shows it whole), the cards waiting for an answer, and the room's own message box beneath. A button
 * opens the room's whole message list as a sheet over the scene.
 */
export function DialogueBox(props: DialogueBoxProps) {
	const { roomKey } = props;
	const connection = useConnection();
	const config = useConfig();
	const history = useRoomHistory(roomKey);
	// The room streams its progress to this page while the box speaks in it.
	const streams = props.streams !== false;
	useEffect(() => {
		if (!streams) return;
		connection.focus(roomKey);
		return () => connection.focus(undefined);
	}, [connection, roomKey, streams]);
	const limits = useSelector((state) => state.limits);
	const cards = useSelector((state) =>
		boxCards(state, roomKey, state.rooms[roomKey]?.messages.at(-1)?.id),
	);
	const characters = useCharacters();
	const { room, view, line } = useRoomLine(roomKey);
	// An agent's own room is that agent's podium: the plate names them even while the newest line is the owner's, which would otherwise put the owner's name under the agent's standee.
	const owned = view?.kind === "agent" ? view : undefined;
	const agent = owned
		? owned.name
		: line?.who === "agent"
			? line.agent
			: undefined;
	const accent = useAccentStyle(agent ? characters[agent] : undefined);

	const speaker = owned
		? owned.displayName
		: line
			? line.author
			: (view?.displayName ?? roomKey);
	const { shown, done, finish } = useReveal(line);
	const [log, setLog] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const style: CSSProperties | undefined =
		line?.who === "owner" && !owned
			? { ["--agent-accent" as string]: "var(--accent)" }
			: accent;
	const typing = Boolean(room?.typing);
	const showProgress = typing && (!line || line.who === "owner");
	const shownText = line ? sliceChars(line.text, shown) : "";
	return (
		<section
			className="scene-box"
			data-open={props.open || undefined}
			data-collapsed={collapsed || undefined}
			data-who={line?.who}
			style={style}
			aria-label={t("Log")}
		>
			<header className="scene-tab">
				{owned || line?.who === "agent" ? (
					<span className="scene-chip">
						<PageCharacter
							spec={agent ? characters[agent] : undefined}
							name={agent ?? speaker}
							size={34}
							live={false}
						/>
					</span>
				) : null}
				<strong className="scene-name">{speaker}</strong>
				<span className="scene-tools">
					{props.onBack ? (
						<button
							type="button"
							className="icon-button"
							aria-label={t("Back to the whole table")}
							onClick={props.onBack}
						>
							<Icon name="back" />
						</button>
					) : null}
					{props.onMenu ? (
						<button
							type="button"
							className="icon-button scene-more"
							aria-label={t("More")}
							aria-haspopup="menu"
							onClick={(event) => props.onMenu?.(event.currentTarget)}
						>
							<Icon name="more" />
						</button>
					) : null}
					<button
						type="button"
						className="icon-button scene-log-button"
						aria-label={t("Log")}
						aria-haspopup="dialog"
						onClick={() => setLog(true)}
					>
						<Icon name="conversations" />
						<span>{t("Log")}</span>
					</button>
					<button
						type="button"
						className="icon-button scene-collapse"
						aria-label={
							collapsed ? t("Show the message box") : t("Hide the message box")
						}
						title={
							collapsed ? t("Show the message box") : t("Hide the message box")
						}
						aria-expanded={!collapsed}
						onClick={() => setCollapsed((now) => !now)}
					>
						{/* The chevron points where the box goes: down to tuck it away, up to bring it back. */}
						<Icon
							name="chevron"
							style={{ rotate: collapsed ? "-90deg" : "90deg" }}
						/>
					</button>
				</span>
			</header>
			{props.strip}
			<div className="scene-body">
				<div
					className="scene-line"
					data-live={line?.live || undefined}
					aria-live="polite"
					{...(done
						? {}
						: {
								role: "button",
								tabIndex: 0,
								title: t("Tap to show the whole message"),
								onClick: finish,
								onKeyDown: (event: React.KeyboardEvent) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										finish();
									}
								},
							})}
				>
					{line ? (
						<>
							{owned && line.who === "owner" ? (
								<span className="scene-from">{line.author}</span>
							) : null}
							<MessageMarkdown source={shownText} />
							{done ? <Files files={line.files} /> : null}
						</>
					) : null}
				</div>
				{showProgress && room ? (
					<ProgressStrip name={speaker} progress={room.progress} />
				) : null}
				{cards.map(({ id, card }) => (
					<div key={id} className="scene-card">
						<PromptCard card={card} timeZone={config.timeZone} />
					</div>
				))}
			</div>
			{view?.readOnly ? null : (
				<div className="scene-composer">
					<Composer
						key={roomKey}
						draftKey={roomKey}
						name={view?.displayName ?? roomKey}
						limits={limits}
						stoppable={Boolean(room?.stoppable)}
						{...(view?.kind === "group"
							? { stopLabel: t("Stop the round") }
							: {})}
						onSend={(text, files) => connection.say(roomKey, text, files)}
						onStop={() => connection.send({ type: "stop", room: roomKey })}
					/>
				</div>
			)}
			<LogSheet
				roomKey={roomKey}
				open={log}
				loaded={history.loaded}
				error={history.error}
				name={view?.displayName ?? roomKey}
				onClose={() => setLog(false)}
			/>
		</section>
	);
}
