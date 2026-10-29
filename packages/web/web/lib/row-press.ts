// A row that opens its action menu (long press, right click, Menu key) and can also be lifted and
// dragged: a touch that rests lifts the row and, if it then lets go without moving, opens the menu
// as it always did; a mouse drags as soon as it moves. The lift code loads on the first press.

import type { DragEvent, MouseEvent, PointerEvent } from "react";
import { useRef } from "react";
import { openMenu } from "./action-menu.ts";
import type { Outcome } from "./drag.ts";
import { type PressProps, useLongPress } from "./long-press.ts";
import type { MenuSpec } from "./menu-items.ts";
import { atScreenEdge } from "./swipe.ts";

/** What a row needs to be lifted. */
export interface Lifting {
	mode: "room" | "folder";
	/** The room key or folder id. */
	key: string;
	/** The element that moves: the row, or the folder's whole block. */
	item(source: HTMLElement): HTMLElement | null;
	/** The region that holds the drop zones, or the folder blocks. */
	root(source: HTMLElement): HTMLElement | null;
	/** A drop, not a cancel or a tap. */
	onDrop(outcome: Exclude<Outcome, { type: "tap" } | { type: "cancel" }>): void;
	/** The finger rests on a folded folder: open it. */
	open(folder: string): void;
}

/** How far a mouse moves (px) with the button down before the row is lifted. */
const MOUSE_SLOP = 6;

let dragModule = () => import("./drag.ts");

/** Loads the lift code through `load` until the returned function is called; for a test that delays the chunk. */
export function loadDragWith(load: typeof dragModule): () => void {
	const before = dragModule;
	dragModule = load;
	return () => {
		dragModule = before;
	};
}

export type RowPressProps = PressProps & {
	onDragStart(event: DragEvent<HTMLElement>): void;
};

export function useRowPress(
	build: (source: HTMLElement) => Promise<MenuSpec | undefined>,
	lifting?: Lifting,
): RowPressProps {
	const latest = useRef(lifting);
	latest.current = lifting;
	const finger = useRef<{ id: number; x: number; y: number }>(undefined);
	const chunk = useRef<ReturnType<typeof dragModule>>(undefined);
	/** A mouse drag happened: the click that follows must not open the row. */
	const dragged = useRef(false);

	const menuFor = (
		source: HTMLElement,
		at: { x: number; y: number },
		via: "hold" | "contextmenu" | "key",
	) =>
		build(source).then(
			(spec) => {
				if (spec) openMenu({ ...spec, at, via, source });
			},
			() => undefined,
		);

	/** Lifts the row now; false when there is nothing to lift. */
	const start = (
		source: HTMLElement,
		pointerId: number,
		y: () => number,
		onTap: () => void,
	): boolean => {
		const spec = latest.current;
		const item = spec?.item(source);
		const root = spec?.root(source);
		if (!spec || !item || !root) return false;
		chunk.current ??= dragModule();
		chunk.current.then(({ lift }) => {
			// The chunk can arrive after the finger has gone: a lift now would wait for a pointer that
			// never comes again and hold the page still. The release is a tap.
			if (finger.current?.id !== pointerId) return onTap();
			lift({
				mode: spec.mode,
				key: spec.key,
				item,
				root,
				pointerId,
				y: y(),
				open: spec.open,
				done: (outcome) => {
					if (outcome.type === "tap") onTap();
					else if (outcome.type !== "cancel") spec.onDrop(outcome);
				},
			});
		}, onTap);
		return true;
	};

	const press = useLongPress((request) => {
		const menu = () => menuFor(request.source, request.at, request.via);
		const touch = finger.current;
		if (request.via !== "hold" || !touch) return void menu();
		const lifted = start(request.source, touch.id, () => touch.y, menu);
		if (!lifted) void menu();
	});

	return {
		...press,
		onPointerDown(event: PointerEvent<HTMLElement>) {
			dragged.current = false;
			finger.current = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
			// A touch that begins at a screen edge belongs to the system; there the hold opens the menu only.
			const edge =
				event.pointerType !== "mouse" &&
				atScreenEdge(event.clientX, window.innerWidth);
			if (edge) finger.current = undefined;
			else if (latest.current) chunk.current ??= dragModule();
			press.onPointerDown(event);
		},
		onPointerMove(event: PointerEvent<HTMLElement>) {
			const touch = finger.current;
			if (touch?.id === event.pointerId) {
				if (
					event.pointerType === "mouse" &&
					event.buttons === 1 &&
					!dragged.current &&
					latest.current &&
					Math.hypot(event.clientX - touch.x, event.clientY - touch.y) >
						MOUSE_SLOP
				) {
					dragged.current = start(
						event.currentTarget,
						event.pointerId,
						() => event.clientY,
						() => undefined,
					);
				}
				touch.y = event.clientY;
			}
			press.onPointerMove(event);
		},
		onPointerUp(event: PointerEvent<HTMLElement>) {
			if (finger.current?.id === event.pointerId) finger.current = undefined;
			press.onPointerUp(event);
		},
		onPointerCancel(event: PointerEvent<HTMLElement>) {
			if (finger.current?.id === event.pointerId) finger.current = undefined;
			press.onPointerCancel(event);
		},
		onContextMenu: press.onContextMenu,
		onKeyDown: press.onKeyDown,
		onClickCapture(event: MouseEvent<HTMLElement>) {
			if (dragged.current) {
				dragged.current = false;
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			press.onClickCapture(event);
		},
		// A link is dragged by the browser as an address; the lift is ours.
		onDragStart(event: DragEvent<HTMLElement>) {
			event.preventDefault();
		},
	};
}
