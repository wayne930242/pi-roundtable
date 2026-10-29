import {
	type CSSProperties,
	useEffect,
	useReducer,
	useRef,
	useState,
} from "react";
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
	/** Goes back to the whole ring; the box offers it as a button when given. */
	onBack?: (() => void) | undefined;
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
	useEffect(() => {
		connection.focus(roomKey);
		return () => connection.focus(undefined);
	}, [connection, roomKey]);
	const room = useSelector((state) => state.rooms[roomKey]);
	const limits = useSelector((state) => state.limits);
	const ownerName = useSelector((state) => state.principal?.name) ?? t("You");
	const cards = useSelector((state) =>
		boxCards(state, roomKey, state.rooms[roomKey]?.messages.at(-1)?.id),
	);
	const characters = useCharacters();
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
	const agent = line?.who === "agent" ? line.agent : undefined;
	const accent = useAccentStyle(agent ? characters[agent] : undefined);
	const speaker = line ? line.author : (view?.displayName ?? roomKey);
	const { shown, done, finish } = useReveal(line);
	const [log, setLog] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const style: CSSProperties | undefined =
		line?.who === "owner"
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
				{line?.who === "agent" ? (
					<span className="scene-chip">
						<PageCharacter
							spec={agent ? characters[agent] : undefined}
							name={agent ?? line.author}
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
						aria-expanded={!collapsed}
						onClick={() => setCollapsed((now) => !now)}
					>
						<Icon name="menu" />
					</button>
				</span>
			</header>
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
