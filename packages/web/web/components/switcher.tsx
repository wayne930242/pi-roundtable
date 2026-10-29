import {
	type KeyboardEvent,
	lazy,
	type PointerEvent,
	type RefObject,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { translate as t } from "../lib/messages.ts";
import { blocksSwipe, Swipe } from "../lib/swipe.ts";

// The rows load apart from the drawer's gesture code: they are only drawn once it opens, and are fetched when it is mounted.
const loadList = () => import("./switcher-list.tsx");
const List = lazy(() =>
	loadList().then((one) => ({ default: one.SwitcherList })),
);

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

/** The drawer that lists the rooms: waiting cards first, then by latest activity, with a search field on top. */
export function RoomSwitcher(props: DrawerProps & { current: string }) {
	const { state, close } = props;
	useEffect(() => {
		void loadList();
	}, []);
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
					<Suspense fallback={null}>
						<List current={props.current} close={close} />
					</Suspense>
				)}
			</div>
		</div>
	);
}
