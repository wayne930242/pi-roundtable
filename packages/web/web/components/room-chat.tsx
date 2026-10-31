import {
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useSelector } from "../lib/app-store.ts";
import { hostUi } from "../lib/frame-taps.ts";
import { translate as t } from "../lib/messages.ts";
import { timeline, waitingCards } from "../lib/rooms.ts";
import { useStickToEnd } from "../lib/stick-to-end.ts";
import { Icon } from "./icons.tsx";
import { ProgressStrip } from "./progress-strip.tsx";
import { loadOlderMessages, RoomLog, useRoomHistory } from "./room-log.tsx";
import { Empty, Failure, Loading } from "./states.tsx";

// The read marks and the divider of new messages load beside the log; until they do the log shows as it is.
const ReadLog = lazy(() => hostUi().then((ui) => ({ default: ui.ReadLog })));

// The chip that brings back a waiting card out of view, and a jump's card, load while a card waits here.
const WaitingChip = lazy(() => import("./waiting-chip.tsx"));

/**
 * A room's conversation as a chat: its messages and cards in a list that opens at the end and keeps
 * it in view, earlier messages on request, the running turn's progress, a button back to the newest,
 * and the room's composer under it. The room's page and the table page's chat mode both show it;
 * `composer` draws the box, given the scroll to the end that a send asks for.
 */
export function RoomChat(props: {
	roomKey: string;
	/** Who the progress strip names when no reply of an agent is there yet. */
	name: string;
	/** Handlers the list carries, such as the room drawer's swipe. */
	surface?: React.HTMLAttributes<HTMLDivElement>;
	composer(toEnd: (smooth: boolean) => void): ReactNode;
}) {
	const { roomKey } = props;
	const room = useSelector((state) => state.rooms[roomKey]);
	const parts = useSelector((state) => ({
		rooms: state.rooms,
		cards: state.cards,
		cardOrder: state.cardOrder,
	}));
	const { loaded, error } = useRoomHistory(roomKey);
	const waiting = useSelector(
		(state) => waitingCards(state, roomKey) > 0,
		roomKey,
	);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { away, onScroll, onGrow, toEnd } = useStickToEnd(scroller);
	const mountedLast = useRef<number | undefined>(undefined);
	const prepend = useRef<number | undefined>(undefined);

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

	const log = {
		roomKey,
		enterAfter: mountedLast.current,
		quotable: !room?.view?.readOnly,
	};
	const lastAgent = [...(room?.messages ?? [])]
		.reverse()
		.find((m) => m.kind === "agent");
	return (
		<>
			{waiting ? (
				<Suspense fallback={null}>
					<WaitingChip roomKey={roomKey} scroller={scroller} loaded={loaded} />
				</Suspense>
			) : null}
			<div
				className="room-scroll"
				ref={scroller}
				onScroll={onScroll}
				{...props.surface}
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
							name={lastAgent?.author ?? props.name}
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
			{props.composer(toEnd)}
		</>
	);
}
