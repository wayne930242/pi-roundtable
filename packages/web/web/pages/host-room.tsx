import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { HostActionView } from "../../src/api-types.ts";
import type { HostHeaderView } from "../../src/host/views.ts";
import { Composer } from "../components/composer.tsx";
import { HostActions, type RunAction } from "../components/host-actions.tsx";
import { HostCard, isOpenCard } from "../components/host-card.tsx";
import { HostPicture } from "../components/host-picture.tsx";
import { Icon } from "../components/icons.tsx";
import { ProgressStrip } from "../components/progress-strip.tsx";
import ReadLog from "../components/read-log.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { ApiFailure, messageOf } from "../lib/api.ts";
import { store, useSelector } from "../lib/app-store.ts";
import { hostApi, splitRoomKey } from "../lib/host-api.ts";
import { keepCards, keepReads, noCards, useHost } from "../lib/host-state.ts";
import { installHostStyle } from "../lib/host-style.ts";
import { translate as t } from "../lib/messages.ts";
import { ROOM_PAGE } from "../lib/rooms.ts";
import { hrefFor } from "../lib/router.ts";
import { useConnection } from "../lib/socket.ts";
import { toast } from "../lib/toast.ts";
import { currentQuery } from "../lib/where.ts";
import { useStickToEnd } from "./room.tsx";

installHostStyle();


/** The most pages of older messages a link to a message pages back through before giving up. */
const MAX_BACK_PAGES = 20;

/** How long a message a link pointed to stays marked. */
const HIGHLIGHT_MS = 2600;

/** The mode the person last wrote in; a room opens in it again. */
let lastMode: "note" | "turn" | undefined;

interface Opened {
	view: import("../../src/host/views.ts").HostRoomView | undefined;
	error: string | undefined;
	/** The room is not there for this person (any more). */
	gone: boolean;
}

/** Fetches the room as it opens, and again after a reconnect and whenever the host says its header or access changed. */
function useHostRoom(roomKey: string, kind: string, id: string): Opened {
	const connects = useSelector((state) => state.connects);
	const changed = useHost((state) => state.rooms[roomKey] ?? 0);
	const [opened, setOpened] = useState<Opened>({
		view: undefined,
		error: undefined,
		gone: false,
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: the room, the connection count and the host's change counter say when to fetch
	useEffect(() => {
		let current = true;
		hostApi.open(kind, id).then(
			(view) => {
				if (!current) return;
				store.dispatch({
					type: "history_loaded",
					room: roomKey,
					messages: view.messages,
					more: view.more,
					older: false,
				});
				keepReads(roomKey, view.reads, view.cursor);
				keepCards(roomKey, view.cards);
				setOpened({ view, error: undefined, gone: false });
			},
			(failure) => {
				if (!current) return;
				const missing = failure instanceof ApiFailure && failure.status === 404;
				setOpened((was) => ({
					view: missing ? undefined : was.view,
					error: messageOf(failure),
					gone: missing,
				}));
			},
		);
		return () => {
			current = false;
		};
	}, [roomKey, kind, id, connects, changed]);
	return opened;
}

/** The facts under the room's title, and its banner and actions. */
function Header(props: { header: HostHeaderView; run: RunAction }) {
	const { header } = props;
	return (
		<>
			{header.banner ? (
				<p
					className="host-banner"
					data-tone={header.banner.tone}
					role="status"
				>
					{header.banner.text}
				</p>
			) : null}
			{header.fields.length ? (
				<dl className="host-head-fields">
					{header.fields.map((field) => (
						<div key={`${field.label}:${field.value}`}>
							<dt>{field.label}</dt>
							<dd>
								{field.link ? (
									<a
										href={field.link}
										{...(field.link.startsWith("/")
											? {}
											: { target: "_blank", rel: "noreferrer noopener" })}
									>
										{field.value}
									</a>
								) : (
									field.value
								)}
							</dd>
						</div>
					))}
				</dl>
			) : null}
			<HostActions
				className="host-actions bar"
				actions={header.actions}
				run={props.run}
			/>
		</>
	);
}

/** The cards that still ask for something, open; the rest folded under them. */
function Cards(props: { room: string; run: (card: string) => RunAction }) {
	const cards = useHost((state) => state.cards[props.room] ?? noCards);
	if (cards.length === 0) return null;
	const live = cards.filter((card) => isOpenCard(card) || card.state === "working");
	const earlier = cards.filter((card) => !live.includes(card));
	return (
		<div className="host-cards">
			{live.map((card) => (
				<HostCard key={card.id} card={card} run={props.run(card.id)} />
			))}
			{earlier.length ? (
				<details className="host-cards-older">
					<summary>
						{t("Earlier cards ({count})", { count: earlier.length })}
					</summary>
					{earlier.map((card) => (
						<HostCard key={card.id} card={card} run={props.run(card.id)} />
					))}
				</details>
			) : null}
		</div>
	);
}

/**
 * A room of the host: its header, the conversation with each author drawn by kind, the host's cards
 * above the box, and the box. The host decides who may read it, write in it as a note or as a turn
 * for its assistant, and press its buttons; this page only shows what the server gives this person.
 */
export function HostRoomPage({ roomKey }: { roomKey: string }) {
	const connection = useConnection();
	const where = splitRoomKey(roomKey);
	const kind = where?.kind ?? "";
	const id = where?.id ?? "";
	const { view, error, gone } = useHostRoom(roomKey, kind, id);
	const room = useSelector((state) => state.rooms[roomKey]);
	const limits = useSelector((state) => state.limits);
	const connects = useSelector((state) => state.connects);
	const open = useSelector((state) => state.connection === "open");
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { away, onScroll, onGrow, toEnd } = useStickToEnd(scroller);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [dropped, setDropped] = useState<File[]>();
	const [mode, setMode] = useState<"note" | "turn" | undefined>(lastMode);
	const [highlight, setHighlight] = useState<number>();
	const mountedLast = useRef<number | undefined>(undefined);
	const prepend = useRef<number | undefined>(undefined);
	const loaded = view !== undefined;

	// The page follows the room's frames while it shows it; a reconnect follows it again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new connection must ask again
	useEffect(() => {
		if (!where || gone) return;
		connection.send({ type: "subscribe", room: roomKey });
		connection.focus(roomKey);
		return () => {
			connection.focus(undefined);
			connection.send({ type: "unsubscribe", room: roomKey });
		};
	}, [connection, roomKey, connects, gone]);

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

	useEffect(() => {
		const element = content.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const watcher = new ResizeObserver(onGrow);
		watcher.observe(element);
		return () => watcher.disconnect();
	}, [onGrow]);

	const loadOlder = useCallback(async (): Promise<boolean> => {
		const first = store.getState().rooms[roomKey]?.messages[0];
		if (!first) return false;
		const page = await hostApi.older(kind, id, first.id, ROOM_PAGE);
		store.dispatch({
			type: "history_loaded",
			room: roomKey,
			messages: page.messages,
			more: page.more,
			older: true,
		});
		keepReads(roomKey, page.reads, undefined);
		return page.more;
	}, [roomKey, kind, id]);

	// A link to a message (`?message=<id>`) scrolls to it and marks it, paging back to it if it is old.
	const target = useRef<number | undefined>(undefined);
	useEffect(() => {
		const read = () => {
			const wanted = Number(currentQuery().get("message"));
			target.current = Number.isSafeInteger(wanted) && wanted > 0 ? wanted : undefined;
		};
		read();
		window.addEventListener("popstate", read);
		return () => window.removeEventListener("popstate", read);
	}, []);
	const first = room?.messages[0]?.id;
	const more = room?.more === true;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a message arriving or an older page loading is when the target may be found
	useEffect(() => {
		const wanted = target.current;
		const element = scroller.current;
		if (!loaded || wanted === undefined || !element) return;
		const found = element.querySelector<HTMLElement>(`[data-mid="${wanted}"]`);
		if (found) {
			target.current = undefined;
			found.scrollIntoView({ block: "center" });
			setHighlight(wanted);
			// The jump is the person's own: the end stays where it is unless they go there.
			requestAnimationFrame(() => element.dispatchEvent(new Event("scroll")));
			setTimeout(() => setHighlight(undefined), HIGHLIGHT_MS);
			return;
		}
		if (first !== undefined && wanted < first && more) {
			let pages = 0;
			const back = async () => {
				pages += 1;
				const again = await loadOlder().catch(() => false);
				if (!again || pages >= MAX_BACK_PAGES) target.current = undefined;
			};
			void back();
		}
	}, [loaded, first, more, room?.messages.length, loadOlder]);

	const press = (action: HostActionView, input = {}, card?: string) =>
		hostApi.act(kind, id, {
			action: action.id,
			...(card === undefined ? {} : { card }),
			input,
		});
	const runHeader: RunAction = (action, input) => press(action, input);
	const runCard = (card: string): RunAction => (action, input) =>
		press(action, input, card);

	if (gone || (!loaded && !error && !where))
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

	const sends = view?.access.send ?? [];
	const chosen: "note" | "turn" | undefined =
		mode && sends.includes(mode) ? mode : (sends.includes("turn") ? "turn" : sends[0]);
	const title = view?.header.title ?? roomKey;
	const messages = room?.messages ?? [];
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: dropping files on the room attaches them; the paperclip is the keyboard path
		<section
			className="room"
			onDragOver={(event) => {
				if (sends.length && event.dataTransfer.types.includes("Files"))
					event.preventDefault();
			}}
			onDrop={(event) => {
				if (!sends.length || !event.dataTransfer.files.length) return;
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
				<HostPicture name={title} size={40} />
				<div className="room-title">
					<h1>{title}</h1>
					<span
						className="room-status"
						data-working={room?.typing || undefined}
					>
						{room?.typing ? t("Working…") : t("Host room")}
					</span>
				</div>
			</header>
			{!open ? (
				<div className="offline-banner" role="status">
					<span className="spinner" aria-hidden="true" />
					{t("Reconnecting… messages wait here until it is back.")}
				</div>
			) : null}
			{view ? <Header header={view.header} run={runHeader} /> : null}
			<div className="room-scroll" ref={scroller} onScroll={onScroll}>
				<div className="room-content" ref={content}>
					{error ? <Failure message={error} /> : null}
					{!loaded && !error ? <Loading /> : null}
					{room?.more ? (
						<button
							type="button"
							className="secondary older"
							disabled={loadingOlder}
							onClick={async () => {
								setLoadingOlder(true);
								prepend.current = scroller.current?.scrollHeight;
								try {
									await loadOlder();
								} catch (failure) {
									prepend.current = undefined;
									toast(messageOf(failure), "danger");
								} finally {
									setLoadingOlder(false);
								}
							}}
						>
							{loadingOlder ? t("Loading…") : t("Load earlier messages")}
						</button>
					) : null}
					{loaded && messages.length === 0 ? (
						<Empty>{t("No messages yet.")}</Empty>
					) : null}
					<ReadLog
						roomKey={roomKey}
						enterAfter={mountedLast.current}
						quotable={false}
						scroller={scroller}
						host
						highlight={highlight}
					/>
					{room?.typing ? (
						<ProgressStrip name={title} progress={room.progress} />
					) : null}
				</div>
			</div>
			{away ? (
				<button type="button" className="to-end" onClick={() => toEnd(true)}>
					<Icon name="send" size={16} style={{ transform: "rotate(180deg)" }} />
					{t("Latest")}
				</button>
			) : null}
			{view ? <Cards room={roomKey} run={runCard} /> : null}
			{view && sends.length === 0 ? (
				<p className="room-note">{t("You can read this room but not write in it.")}</p>
			) : null}
			{view && sends.length > 0 ? (
				<>
					{sends.length > 1 ? (
						<fieldset className="mode-switch" aria-label={t("Send as")}>
							{sends.map((one) => (
								<button
									key={one}
									type="button"
									className={chosen === one ? "" : "secondary"}
									aria-pressed={chosen === one}
									onClick={() => {
										lastMode = one;
										setMode(one);
									}}
								>
									{one === "note" ? t("Note") : t("Ask the agent")}
								</button>
							))}
						</fieldset>
					) : null}
					<Composer
						key={roomKey}
						draftKey={roomKey}
						name={title}
						limits={limits}
						stoppable={Boolean(room?.stoppable)}
						onSend={(text, files) => {
							connection.say(roomKey, text, files, chosen);
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
				</>
			) : null}
		</section>
	);
}
