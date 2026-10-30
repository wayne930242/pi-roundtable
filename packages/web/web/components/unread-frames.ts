import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { RoomMessage } from "../../src/api-types.ts";

/** How long a message must stand mostly in view of a touch screen before its frame goes. */
export const GLANCE_MS = 1500;

/** How close to the end of the log the person counts as watching it arrive. */
const NEAR_END = 96;

const NONE: ReadonlySet<number> = new Set();

// The frames a person cleared, by room, for as long as the page lives: leaving a room and coming
// back does not frame them again, a reload (which asks the server for the read marker) does.
const cleared = new Map<string, ReadonlySet<number>>();

interface Arrivals {
	/** The newest message id the log has taken a look at. */
	seen: number | undefined;
	/** Messages that came while the person watched the end of the log. */
	watched: Set<number>;
}

/** Whether the person is looking at the end of the log: the page is in view and the scroller rests at its end. */
function watching(root: HTMLElement | null): boolean {
	if (document.visibilityState !== "visible") return false;
	return (
		!root || root.scrollHeight - root.scrollTop - root.clientHeight < NEAR_END
	);
}

/** Whether the message at `target` (or inside it) carries a frame, and which message that is. */
function framedIn(target: EventTarget | null): number | undefined {
	if (!(target instanceof Element)) return undefined;
	const item = target.closest<HTMLElement>("[data-unread][data-mid]");
	return item ? Number(item.dataset.mid) : undefined;
}

/**
 * Which messages of a room wear the unread frame. A message does when it lay past the person's
 * read marker as the room opened, or came later while they were not watching the end of the log
 * (the tab hidden, or the log scrolled away). Their own messages, lines the server wrote, notes
 * and messages that arrive in front of their eyes do not. The frame is only a look: a pointer
 * passing over a message, keyboard focus on it or a tap clears it; on a touch screen it also
 * clears once the message has stood mostly in view for a moment. Reading itself is reported as
 * before.
 */
export function useUnreadFrames(props: {
	room: string;
	scroller: RefObject<HTMLElement | null>;
	messages: readonly RoomMessage[] | undefined;
	/** The person's read marker as the room opened. */
	began: number | undefined;
	/** The newest message the room held when its first page arrived; none until then. */
	enterAfter: number | undefined;
	me: string | undefined;
	/** Where several people read, an old message without an author's principal belongs to none of them. */
	shared: boolean;
}): ReadonlySet<number> {
	const { room, scroller, messages, began, enterAfter, me, shared } = props;
	const arrivals = useRef<Arrivals>({ seen: undefined, watched: new Set() });
	const [, setVersion] = useState(0);
	const gone = cleared.get(room) ?? NONE;

	// Looks at what came since the last render, before the new rows are laid out, so the scroller
	// still shows where the person was.
	if (enterAfter !== undefined && messages) {
		const book = arrivals.current;
		book.seen ??= enterAfter;
		const atEnd = watching(scroller.current);
		let newest = book.seen;
		for (const message of messages) {
			if (message.id <= book.seen) continue;
			if (atEnd) book.watched.add(message.id);
			newest = Math.max(newest, message.id);
		}
		book.seen = newest;
	}

	const framed = useMemo(() => {
		if (began === undefined || enterAfter === undefined || !messages)
			return NONE;
		const ids = new Set<number>();
		for (const message of messages) {
			if (message.id === 0 || message.id <= began) continue;
			if (message.kind === "system" || message.note) continue;
			if (message.authorKind === "notice") continue;
			const mine =
				message.principalId === undefined
					? message.kind === "owner" && !shared
					: message.principalId === me;
			if (mine) continue;
			if (arrivals.current.watched.has(message.id) || gone.has(message.id))
				continue;
			ids.add(message.id);
		}
		return ids.size === 0 ? NONE : ids;
	}, [messages, began, enterAfter, me, shared, gone]);

	const clear = useCallback(
		(id: number) => {
			const held = cleared.get(room) ?? NONE;
			if (held.has(id)) return;
			cleared.set(room, new Set(held).add(id));
			setVersion((count) => count + 1);
		},
		[room],
	);

	const any = framed.size > 0;

	// A pointer passing over a message, focus reaching it, a tap on it.
	useEffect(() => {
		const root = scroller.current;
		if (!root || !any) return;
		const over = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			const id = framedIn(event.target);
			if (id !== undefined) clear(id);
		};
		const reach = (event: Event) => {
			const id = framedIn(event.target);
			if (id !== undefined) clear(id);
		};
		root.addEventListener("pointerover", over, { passive: true });
		root.addEventListener("focusin", reach, { passive: true });
		root.addEventListener("click", reach, { passive: true });
		return () => {
			root.removeEventListener("pointerover", over);
			root.removeEventListener("focusin", reach);
			root.removeEventListener("click", reach);
		};
	}, [scroller, clear, any]);

	// On a touch screen there is no passing over: a message that has stood mostly in view for a moment is seen.
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
	const key = [...framed].join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the framed set
	useEffect(() => {
		const root = scroller.current;
		const pending = timers.current;
		for (const [id, timer] of pending)
			if (!framed.has(id)) {
				clearTimeout(timer);
				pending.delete(id);
			}
		if (
			!root ||
			!any ||
			typeof IntersectionObserver !== "function" ||
			!matchMedia("(pointer: coarse)").matches
		)
			return;
		const stop = (id: number) => {
			const timer = pending.get(id);
			if (timer === undefined) return;
			clearTimeout(timer);
			pending.delete(id);
		};
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = Number((entry.target as HTMLElement).dataset.mid);
					const bounds = entry.rootBounds;
					// A message taller than the screen can never fill half of itself: half the screen does.
					const mostly =
						entry.isIntersecting &&
						(entry.intersectionRatio >= 0.5 ||
							(bounds !== null &&
								entry.intersectionRect.height >= bounds.height * 0.5));
					if (!mostly) {
						stop(id);
						continue;
					}
					if (pending.has(id)) continue;
					pending.set(
						id,
						setTimeout(() => {
							pending.delete(id);
							if (document.visibilityState === "visible") clear(id);
						}, GLANCE_MS),
					);
				}
			},
			{ root, threshold: [0, 0.25, 0.5, 0.75, 1] },
		);
		const items = [
			...root.querySelectorAll<HTMLElement>("[data-unread][data-mid]"),
		];
		for (const item of items) observer.observe(item);
		// Coming back to the page counts again from now: what was in view meanwhile was not seen.
		const resume = () => {
			if (document.visibilityState !== "visible") return;
			for (const item of items) {
				observer.unobserve(item);
				observer.observe(item);
			}
		};
		document.addEventListener("visibilitychange", resume);
		return () => {
			document.removeEventListener("visibilitychange", resume);
			observer.disconnect();
		};
	}, [scroller, clear, any, key]);
	useEffect(() => {
		const pending = timers.current;
		return () => {
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
		};
	}, []);

	return framed;
}
