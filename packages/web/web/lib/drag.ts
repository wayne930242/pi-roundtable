// The lifted row or folder: it follows the finger, the others move over to make room, the view
// scrolls near its edges, and the zone under the finger lights up. Loaded on the first lift only.
// The decisions (where a drop lands) are `reorder.ts`; this file measures and paints.

import {
	HOVER_OPEN_MS,
	type ItemBox,
	landing,
	type RoomDrop,
	resolveFolderDrop,
	resolveRoomDrop,
	scrollStep,
	shifts,
	type Zone,
} from "./reorder.ts";

export type Outcome =
	| { type: "tap" }
	| { type: "cancel" }
	| { type: "room"; drop: RoomDrop }
	| { type: "folder"; before: string | null };

export interface Lift {
	mode: "room" | "folder";
	/** The row (`[data-drop-item]`) or the folder block (`[data-folder-block]`) that was lifted. */
	item: HTMLElement;
	/** Its room key or folder id. */
	key: string;
	pointerId: number;
	y: number;
	/** The region that holds the zones or the folder blocks. */
	root: HTMLElement;
	/** The finger rests on a folded folder: open it. */
	open(folder: string): void;
	done(outcome: Outcome): void;
}

/** A finger that moves less than this (px) and lifts did not drag. */
const TAP = 6;

const scroller = (from: HTMLElement): HTMLElement => {
	for (let el: HTMLElement | null = from; el; el = el.parentElement) {
		const { overflowY } = getComputedStyle(el);
		if (
			(overflowY === "auto" || overflowY === "scroll") &&
			el.scrollHeight > el.clientHeight
		)
			return el;
	}
	return (document.scrollingElement ?? document.documentElement) as HTMLElement;
};

/** Lifts the item and follows the finger until it lets go; returns what stops the lift early. */
export function lift(options: Lift): () => void {
	const { item, root, key, mode } = options;
	const view = scroller(root);
	const isPage =
		view === document.scrollingElement || view === document.documentElement;
	const viewTop = () => (isPage ? 0 : view.getBoundingClientRect().top);
	const viewHeight = () => (isPage ? window.innerHeight : view.clientHeight);
	/** Client y → y in the scrolling content, which scrolling does not change. */
	const content = (clientY: number) => clientY - viewTop() + view.scrollTop;
	const boxOf = (el: HTMLElement): { top: number; height: number } => {
		const rect = el.getBoundingClientRect();
		return { top: content(rect.top), height: rect.height };
	};
	const line = document.createElement("div");
	line.className = "drop-line";
	line.setAttribute("aria-hidden", "true");

	let zones: Zone[] = [];
	let zoneEls: HTMLElement[] = [];
	let peers: HTMLElement[] = [];
	let boxes: ItemBox[] = [];
	let headers: ItemBox[] = [];
	let bounds = { top: 0, bottom: 0 };
	const measure = () => {
		if (mode === "room") {
			zoneEls = [...root.querySelectorAll<HTMLElement>("[data-drop-zone]")];
			zones = zoneEls.map((el) => {
				const { top, height } = boxOf(el);
				return {
					id: el.dataset.zoneId ?? "",
					kind: el.dataset.dropZone as Zone["kind"],
					...(el.dataset.folder ? { folder: el.dataset.folder } : {}),
					top,
					bottom: top + height,
					items: [...el.querySelectorAll<HTMLElement>("[data-drop-item]")].map(
						(row) => ({ key: row.dataset.key ?? "", ...boxOf(row) }),
					),
				};
			});
			return;
		}
		peers = [
			...root.querySelectorAll<HTMLElement>(":scope > [data-folder-block]"),
		];
		boxes = peers.map((el) => ({ key: el.dataset.key ?? "", ...boxOf(el) }));
		headers = peers.map((el) => ({
			key: el.dataset.key ?? "",
			...boxOf(el.querySelector<HTMLElement>("[data-folder-head]") ?? el),
		}));
		const all = boxOf(root);
		bounds = { top: all.top, bottom: all.top + all.height };
	};
	measure();

	const startContent = content(options.y);
	let at = { x: 0, y: options.y };
	let moved = false;
	let frame = 0;
	let target: HTMLElement | undefined;
	let dwell: { zone: string; timer: ReturnType<typeof setTimeout> } | undefined;
	let result: Outcome = { type: "cancel" };

	item.setAttribute("data-lifted", "");
	root.setAttribute("data-reordering", "");
	try {
		item.setPointerCapture(options.pointerId);
	} catch {
		// The window listeners below still follow the finger.
	}

	const paint = () => {
		frame = 0;
		const y = content(at.y);
		const dy = y - startContent;
		if (Math.abs(dy) >= TAP) moved = true;
		item.style.transform = `translate3d(0, ${dy}px, 0)`;
		let lit: HTMLElement | undefined;
		if (mode === "room") {
			const drop = resolveRoomDrop(zones, key, y);
			result = drop ? { type: "room", drop } : { type: "cancel" };
			const index = drop ? zones.indexOf(drop.zone) : -1;
			lit = zoneEls[index];
			const own = lit?.contains(item) ?? false;
			// In its own list the others move over; into another zone a line shows the place.
			const items = drop ? drop.zone.items : [];
			const rows = own
				? [
						...(lit as HTMLElement).querySelectorAll<HTMLElement>(
							"[data-drop-item]",
						),
					]
				: [];
			const from = items.findIndex((one) => one.key === key);
			const to = drop
				? landing(
						items.map((one) => one.key),
						key,
						drop.before,
					)
				: 0;
			const gap =
				items.length > 1
					? Math.max(
							0,
							(items[1]?.top ?? 0) -
								(items[0]?.top ?? 0) -
								(items[0]?.height ?? 0),
						)
					: 0;
			const move = own && from >= 0 ? shifts(items, from, to, gap) : [];
			for (const row of document.querySelectorAll<HTMLElement>(
				"[data-drop-item]:not([data-lifted])",
			))
				row.style.removeProperty("transform");
			rows.forEach((row, i) => {
				if (move[i]) row.style.transform = `translate3d(0, ${move[i]}px, 0)`;
			});
			if (lit && drop && !own) {
				const next =
					drop.before === null
						? undefined
						: drop.zone.items.find((one) => one.key === drop.before);
				const base = boxOf(lit).top;
				const y0 = next
					? next.top - base
					: drop.zone.items.length
						? boxOf(lit).height
						: 0;
				line.style.top = `${y0}px`;
				lit.append(line);
			} else line.remove();
			if (
				drop?.zone.kind === "folder" &&
				drop.zone.items.length === 0 &&
				lit?.dataset.collapsed !== undefined
			) {
				if (dwell?.zone !== drop.zone.id) {
					if (dwell) clearTimeout(dwell.timer);
					const folder = drop.zone.folder ?? "";
					dwell = {
						zone: drop.zone.id,
						timer: setTimeout(() => {
							options.open(folder);
							// The folder grows once drawn; measure again after.
							requestAnimationFrame(() =>
								requestAnimationFrame(() => {
									measure();
									schedule();
								}),
							);
						}, HOVER_OPEN_MS),
					};
				}
			} else if (dwell) {
				clearTimeout(dwell.timer);
				dwell = undefined;
			}
		} else {
			const drop = resolveFolderDrop(headers, bounds, key, y);
			result = drop
				? { type: "folder", before: drop.before }
				: { type: "cancel" };
			const from = boxes.findIndex((one) => one.key === key);
			const to = drop
				? landing(
						boxes.map((one) => one.key),
						key,
						drop.before,
					)
				: from;
			const move = shifts(boxes, from, to, 12);
			peers.forEach((el, i) => {
				if (el !== item)
					el.style.transform = move[i] ? `translate3d(0, ${move[i]}px, 0)` : "";
			});
		}
		if (lit !== target) {
			target?.removeAttribute("data-drop-target");
			lit?.setAttribute("data-drop-target", "");
			target = lit;
		}
		// Near the top or bottom of the view it scrolls, and the lifted item keeps following the finger.
		const step = scrollStep(at.y, viewTop(), viewTop() + viewHeight());
		if (step) {
			view.scrollTop += step;
			schedule();
		}
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(paint);
	};

	const end = (outcome: Outcome) => {
		cleanup();
		options.done(outcome);
	};
	const mine = (event: PointerEvent) => event.pointerId === options.pointerId;
	const onMove = (event: PointerEvent) => {
		if (!mine(event)) return;
		event.stopPropagation();
		event.preventDefault();
		at = { x: event.clientX, y: event.clientY };
		schedule();
	};
	const onUp = (event: PointerEvent) => {
		if (!mine(event)) return;
		event.stopPropagation();
		if (frame) {
			cancelAnimationFrame(frame);
			paint();
		}
		end(moved ? result : { type: "tap" });
	};
	const onCancel = (event: PointerEvent) => {
		if (mine(event)) end({ type: "cancel" });
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		end({ type: "cancel" });
	};
	const hold = (event: Event) => event.preventDefault();
	function cleanup() {
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("pointerup", onUp, true);
		window.removeEventListener("pointercancel", onCancel, true);
		window.removeEventListener("keydown", onKey, true);
		window.removeEventListener("touchmove", hold, true);
		window.removeEventListener("contextmenu", hold, true);
		if (frame) cancelAnimationFrame(frame);
		if (dwell) clearTimeout(dwell.timer);
		target?.removeAttribute("data-drop-target");
		line.remove();
		item.removeAttribute("data-lifted");
		item.style.removeProperty("transform");
		root.removeAttribute("data-reordering");
		for (const el of root.querySelectorAll<HTMLElement>(
			"[data-drop-item], [data-folder-block]",
		))
			el.style.removeProperty("transform");
		try {
			item.releasePointerCapture(options.pointerId);
		} catch {
			// It was not captured.
		}
	}
	window.addEventListener("pointermove", onMove, true);
	window.addEventListener("pointerup", onUp, true);
	window.addEventListener("pointercancel", onCancel, true);
	window.addEventListener("keydown", onKey, true);
	// The page must not scroll under the finger once a row is lifted.
	window.addEventListener("touchmove", hold, { capture: true, passive: false });
	window.addEventListener("contextmenu", hold, true);
	schedule();
	return () => end({ type: "cancel" });
}
