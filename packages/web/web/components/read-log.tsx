import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { ReadMarkView, RoomMessage } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { noReads, useHost } from "../lib/host-state.ts";
import { installHostStyle } from "../lib/host-style.ts";
import { translate as t } from "../lib/messages.ts";
import { useConnection } from "../lib/socket.ts";
import { HostMessageRow } from "./host-message.tsx";
import { HostPicture } from "./host-picture.tsx";
import { RoomLog, type RowDecor } from "./room-log.tsx";

installHostStyle();

/** The most pictures of readers shown under a message before the count says the rest. */
const PICTURES = 3;

/** Who has read up to a message: their pictures and a count that opens the names. */
function Seen({ marks }: { marks: readonly ReadMarkView[] }) {
	const [open, setOpen] = useState(false);
	return (
		<li className="seen">
			<button
				type="button"
				className="seen-toggle"
				aria-expanded={open}
				onClick={() => setOpen((was) => !was)}
			>
				{marks.slice(0, PICTURES).map((mark) => (
					<HostPicture
						key={mark.principal}
						picture={{ principal: mark.principal }}
						name={mark.name}
						size={16}
					/>
				))}
				<span>{t("Seen by {count}", { count: marks.length })}</span>
			</button>
			{open ? (
				<span className="seen-names">
					{marks.map((mark) => mark.name).join(t(", "))}
				</span>
			) : null}
		</li>
	);
}

/**
 * Tells the server how far the person has read: the newest message whose box is in the scroller's
 * view while the page is visible. The server keeps a cursor that never moves back, and this sends
 * a new one at most once a second.
 */
function useReadReporting(
	room: string,
	scroller: RefObject<HTMLElement | null>,
): void {
	const connection = useConnection();
	const connects = useSelector((state) => state.connects);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new connection says the server may have lost the cursor
	useEffect(() => {
		const root = scroller.current;
		if (!root) return;
		let sent = 0;
		let last = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let frame: number | undefined;
		const measure = () => {
			frame = undefined;
			if (document.visibilityState !== "visible") return;
			const box = root.getBoundingClientRect();
			let seen = 0;
			for (const item of root.querySelectorAll<HTMLElement>("[data-mid]")) {
				const at = item.getBoundingClientRect();
				if (at.bottom > box.top && at.top < box.bottom - 4)
					seen = Math.max(seen, Number(item.dataset.mid));
			}
			if (seen <= sent) return;
			const wait = last + 1000 - Date.now();
			if (wait > 0) {
				clearTimeout(timer);
				timer = setTimeout(schedule, wait);
				return;
			}
			if (connection.send({ type: "read", room, upTo: seen })) {
				sent = seen;
				last = Date.now();
			}
		};
		const schedule = () => {
			if (frame === undefined) frame = requestAnimationFrame(measure);
		};
		root.addEventListener("scroll", schedule, { passive: true });
		document.addEventListener("visibilitychange", schedule);
		window.addEventListener("resize", schedule);
		const watcher = new MutationObserver(schedule);
		watcher.observe(root, { childList: true, subtree: true });
		schedule();
		return () => {
			root.removeEventListener("scroll", schedule);
			document.removeEventListener("visibilitychange", schedule);
			window.removeEventListener("resize", schedule);
			watcher.disconnect();
			clearTimeout(timer);
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [connection, room, scroller, connects]);
}

/** The log of a room with its read marks: a divider where the new messages begin, who has read what. */
export default function ReadLog(props: {
	roomKey: string;
	enterAfter: number | undefined;
	quotable: boolean;
	scroller: RefObject<HTMLElement | null>;
	/** A host room: its messages are drawn by author kind. */
	host?: boolean;
	/** A message to mark out, from a link to it. */
	highlight?: number | undefined;
}) {
	const { roomKey } = props;
	useReadReporting(roomKey, props.scroller);
	const me = useSelector((state) => state.principal?.id);
	const messages = useSelector((state) => state.rooms[roomKey]?.messages);
	const reads = useHost((state) => state.reads[roomKey] ?? noReads);
	const cursor = useHost((state) => state.cursor[roomKey]);
	// The divider stays where the new messages began when the room opened, however far the person reads.
	const began = useRef<number | undefined>(undefined);
	if (began.current === undefined && cursor !== undefined)
		began.current = cursor;

	const decor = useMemo<RowDecor>(() => {
		const list: readonly RoomMessage[] = messages ?? [];
		const counted = list.filter((message) => message.kind !== "system");
		const first =
			began.current === undefined
				? undefined
				: counted.find(
						(message) =>
							message.id > (began.current ?? 0) &&
							(message.principalId === undefined || message.principalId !== me),
					)?.id;
		const under = new Map<number, ReadMarkView[]>();
		for (const mark of reads) {
			if (mark.principal === me) continue;
			const at = counted.findLast((message) => message.id <= mark.upTo);
			if (at) under.set(at.id, [...(under.get(at.id) ?? []), mark]);
		}
		return {
			before: (message) =>
				message.id === first ? (
					<li className="new-divider">
						<span>{t("New messages")}</span>
					</li>
				) : null,
			after: (message) => {
				const marks = under.get(message.id);
				return marks ? <Seen marks={marks} /> : null;
			},
			...(props.host
				? {
						message: (message: RoomMessage, look) =>
							message.kind === "system" &&
							message.authorKind === undefined ? undefined : (
								<HostMessageRow
									message={message}
									header={look.header}
									enter={look.enter}
									timeZone={look.timeZone}
									me={me}
									highlighted={props.highlight === message.id}
								/>
							),
					}
				: {}),
		};
	}, [messages, reads, me, props.host, props.highlight]);
	return (
		<RoomLog
			roomKey={roomKey}
			enterAfter={props.enterAfter}
			quotable={props.quotable}
			decor={decor}
		/>
	);
}
