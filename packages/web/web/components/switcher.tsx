import {
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useSelector } from "../lib/app-store.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { fuzzyScore } from "../lib/fuzzy.ts";
import { composingKey } from "../lib/ime.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { switcherOrder, waitingCards } from "../lib/rooms.ts";
import { hrefFor, navigate } from "../lib/router.ts";
import { blocksSwipe, Swipe } from "../lib/swipe.ts";
import { Icon } from "./icons.tsx";
import { RoomPicture } from "./room-picture.tsx";

type DrawerState = "closed" | "dragging" | "open";

/** The history entry the open drawer stands on, so the system Back closes it before it leaves the room. */
const ENTRY = { rtSwitcher: true };
const onEntry = (): boolean =>
	Boolean(
		(window.history.state as { rtSwitcher?: boolean } | null)?.rtSwitcher,
	);

/** What the drawer needs from `useSwitcher`. */
export interface DrawerProps {
	state: DrawerState;
	root: RefObject<HTMLDivElement | null>;
	panel: RefObject<HTMLDivElement | null>;
	/** Closes the drawer by stepping back off its history entry, then runs `then`. */
	close(then?: () => void): void;
	/** The swipe that closes an open drawer. */
	handlers: SwipeHandlers;
}

interface SwipeHandlers {
	onPointerDown(event: PointerEvent<HTMLElement>): void;
	onPointerMove(event: PointerEvent<HTMLElement>): void;
	onPointerUp(event: PointerEvent<HTMLElement>): void;
	onPointerCancel(event: PointerEvent<HTMLElement>): void;
}

/**
 * The room switcher's drawer on a phone: a swipe right over the message list pulls it open
 * (`surface`), `show` opens it from a button, and a tap, a swipe left, Escape or the system Back
 * closes it. A touch that starts within the edge guard is never ours (see `Swipe`).
 */
export function useSwitcher(enabled: boolean): {
	enabled: boolean;
	surface: SwipeHandlers;
	show(): void;
	drawer: DrawerProps;
} {
	const [open, setOpen] = useState(false);
	const [dragging, setDragging] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const swipe = useRef<{ pointer: number; swipe: Swipe } | undefined>(
		undefined,
	);
	const live = useRef(false);
	/** The drawer stands on its own history entry. */
	const pushed = useRef(false);
	const after = useRef<(() => void) | undefined>(undefined);
	const returnTo = useRef<Element | null>(null);

	const commitOpen = useCallback(() => {
		if (!pushed.current) {
			window.history.pushState(ENTRY, "", window.location.href);
			pushed.current = true;
		}
		returnTo.current = document.activeElement;
		setOpen(true);
	}, []);

	const close = useCallback((then?: () => void) => {
		if (!pushed.current) {
			setOpen(false);
			then?.();
			return;
		}
		after.current = then;
		window.history.back();
	}, []);

	// The step back off the drawer's entry (the system Back, or `close`) is what closes it.
	useEffect(() => {
		const onPop = () => {
			if (pushed.current && !onEntry()) {
				pushed.current = false;
				setOpen(false);
				const then = after.current;
				after.current = undefined;
				then?.();
			} else if (!pushed.current && onEntry())
				// Forward onto an entry of a drawer that is gone: it is a copy of the page now.
				window.history.replaceState(null, "", window.location.href);
		};
		window.addEventListener("popstate", onPop);
		return () => {
			window.removeEventListener("popstate", onPop);
			if (pushed.current && onEntry())
				window.history.replaceState(null, "", window.location.href);
		};
	}, []);

	// A drawer that is open takes focus, and gives it back when it closes.
	useEffect(() => {
		if (open) panel.current?.focus();
		else if (returnTo.current instanceof HTMLElement) {
			returnTo.current.focus();
			returnTo.current = null;
		}
	}, [open]);

	const paint = (progress: number | undefined) => {
		const element = root.current;
		if (!element) return;
		if (progress === undefined)
			element.style.removeProperty("--switcher-progress");
		else element.style.setProperty("--switcher-progress", String(progress));
	};

	const handlers = (from: "closed" | "open"): SwipeHandlers => {
		const finish = (event: PointerEvent<HTMLElement>) => {
			const current = swipe.current;
			if (!current || current.pointer !== event.pointerId) return;
			swipe.current = undefined;
			if (!live.current) return;
			live.current = false;
			const opens = current.swipe.finish(event.timeStamp);
			setDragging(false);
			paint(undefined);
			if (opens === undefined) return;
			if (opens) commitOpen();
			else if (from === "open") close();
		};
		return {
			onPointerDown(event) {
				if (event.pointerType !== "touch") return;
				// A second finger ends the swipe.
				if (swipe.current) {
					swipe.current = undefined;
					return;
				}
				if (from === "closed" && (!enabled || open)) return;
				if (blocksSwipe(event.target, event.currentTarget)) return;
				const started = new Swipe(from, window.innerWidth);
				if (started.begin(event.clientX, event.clientY, event.timeStamp))
					swipe.current = { pointer: event.pointerId, swipe: started };
			},
			onPointerMove(event) {
				const current = swipe.current;
				if (!current || current.pointer !== event.pointerId) return;
				const moved = current.swipe.move(
					event.clientX,
					event.clientY,
					event.timeStamp,
				);
				if (moved.state === "reject") {
					swipe.current = undefined;
					return;
				}
				if (moved.state !== "drag") return;
				if (!live.current) {
					live.current = true;
					setDragging(true);
					event.currentTarget.setPointerCapture?.(event.pointerId);
				}
				paint(moved.progress);
			},
			onPointerUp: finish,
			onPointerCancel: finish,
		};
	};

	return {
		enabled,
		surface: handlers("closed"),
		show: () => {
			if (enabled && !open) commitOpen();
		},
		drawer: {
			state: dragging ? "dragging" : open ? "open" : "closed",
			root,
			panel,
			close,
			handlers: handlers("open"),
		},
	};
}

/** What the drawer lists of a room: key, name, and whether a card waits there. */
interface Entry {
	key: string;
	name: string;
	waiting: boolean;
}

function useEntries(): Entry[] {
	const shape = useSelector((state) =>
		JSON.stringify(
			switcherOrder(state).map((key) => ({
				key,
				name: state.rooms[key]?.view?.displayName ?? key,
				waiting: waitingCards(state, key) > 0,
			})),
		),
	);
	return useMemo(() => JSON.parse(shape) as Entry[], [shape]);
}

function Row(props: {
	entry: Entry;
	current: string;
	onPick(key: string): void;
}) {
	const { key, name } = props.entry;
	const room = useSelector((state) => state.rooms[key]);
	const waiting = useSelector((state) => waitingCards(state, key));
	const view = room?.view;
	const accent = useAccentStyle(view?.character);
	if (!view) return null;
	return (
		<li>
			<a
				className="switcher-row"
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

function List(props: { current: string; close(then?: () => void): void }) {
	const [query, setQuery] = useState("");
	const entries = useEntries();
	const shown = entries.filter(
		(entry) => fuzzyScore(query, entry.name) !== undefined,
	);
	const waiting = shown.filter((entry) => entry.waiting);
	const rest = shown.filter((entry) => !entry.waiting);
	const pick = (key: string) =>
		props.close(
			key === props.current ? undefined : () => navigate("room", key),
		);
	const rows = (list: Entry[]) => (
		<ul className="switcher-list">
			{list.map((entry) => (
				<Row
					key={entry.key}
					entry={entry}
					current={props.current}
					onPick={pick}
				/>
			))}
		</ul>
	);
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
						const first = shown[0];
						if (
							event.key === "Enter" &&
							first &&
							!composingKey(event.nativeEvent)
						)
							pick(first.key);
					}}
				/>
			</div>
			<div className="switcher-scroll">
				{waiting.length > 0 ? (
					<section aria-label={t("Waiting for you")}>
						<h2 className="switcher-heading" data-waiting="">
							{t("Waiting for you")}
						</h2>
						{rows(waiting)}
					</section>
				) : null}
				{rest.length > 0 ? (
					<section aria-label={t("Rooms")}>
						{waiting.length > 0 ? (
							<h2 className="switcher-heading">{t("Rooms")}</h2>
						) : null}
						{rows(rest)}
					</section>
				) : null}
			</div>
		</>
	);
}

/** The drawer that lists the rooms: waiting cards first, then by latest activity, with a search field on top. */
export function RoomSwitcher(props: DrawerProps & { current: string }) {
	const { state, close } = props;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Escape is a keyboard shortcut for the dialog inside; the swipe is a touch gesture with the scrim's tap as the pointer path
		<div
			className="switcher"
			ref={props.root}
			data-state={state}
			inert={state === "closed"}
			onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
				if (event.key === "Escape" && state !== "closed") {
					event.stopPropagation();
					close();
				}
			}}
			{...props.handlers}
		>
			<div
				className="switcher-scrim"
				aria-hidden="true"
				onClick={() => close()}
			/>
			<div
				className="switcher-panel"
				ref={props.panel}
				role="dialog"
				aria-modal="true"
				aria-label={t("Switch rooms")}
				tabIndex={-1}
			>
				{state === "closed" ? null : (
					<List current={props.current} close={close} />
				)}
			</div>
		</div>
	);
}
