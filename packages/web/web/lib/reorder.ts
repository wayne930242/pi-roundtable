// Where a dragged row or folder lands, as plain functions over measured boxes, so the drop rules can
// be tested without a pointer. The DOM side (`drag.ts`) measures, calls these, and paints.

import { moveBefore } from "../../src/layout-order.ts";
import type { Place } from "./sections.ts";

/** An item's place in the scrolling content: `top` and `height` in px. */
export interface Box {
	top: number;
	height: number;
}
export interface ItemBox extends Box {
	key: string;
}

/** A place a room can be dropped: the pinned list, a folder, or the rest of the rooms. */
export interface Zone {
	id: string;
	kind: "pinned" | "folder" | "rest";
	/** The folder's id for a folder. */
	folder?: string;
	top: number;
	bottom: number;
	/** The rows in it, in order; none for a collapsed or empty folder. */
	items: ItemBox[];
}

/** How far outside a zone a finger still counts as over it: the gap between sections. */
export const ZONE_SLACK = 12;

/** The zone the finger is over; the nearest one within the slack for a finger in a gap; none outside. */
export function zoneAt(zones: readonly Zone[], y: number): Zone | undefined {
	const inside = zones.find((zone) => y >= zone.top && y <= zone.bottom);
	if (inside) return inside;
	let best: Zone | undefined;
	let distance = ZONE_SLACK + 1;
	for (const zone of zones) {
		const away = y < zone.top ? zone.top - y : y - zone.bottom;
		if (away < distance) {
			best = zone;
			distance = away;
		}
	}
	return best;
}

/** The key of the first item below `y`'s midpoint line, or none for the end; `skip` is the item being dragged. */
export function beforeAt(
	items: readonly ItemBox[],
	skip: string,
	y: number,
): string | null {
	for (const item of items)
		if (item.key !== skip && item.top + item.height / 2 > y) return item.key;
	return null;
}

/** What a dropped room did: the zone it is over and the room it goes before there. */
export interface RoomDrop {
	zone: Zone;
	before: string | null;
}

/** The drop of a room whose finger is at `y`; undefined when it is over no zone, which cancels. */
export function resolveRoomDrop(
	zones: readonly Zone[],
	dragged: string,
	y: number,
): RoomDrop | undefined {
	const zone = zoneAt(zones, y);
	return zone ? { zone, before: beforeAt(zone.items, dragged, y) } : undefined;
}

/** The edit a drop asks for, or none when the room would stay where and as it is. */
export type RoomEdit =
	| { kind: "pin"; before: string | null }
	| { kind: "folder"; folder: string; before: string | null }
	| { kind: "unplace" };

export function editFor(
	origin: Place,
	room: string,
	drop: RoomDrop,
): RoomEdit | undefined {
	const { zone, before } = drop;
	if (zone.kind === "rest")
		return origin.kind === "rest" ? undefined : { kind: "unplace" };
	const sameList =
		(zone.kind === "pinned" && origin.kind === "pinned") ||
		(zone.kind === "folder" &&
			origin.kind === "folder" &&
			origin.folder === zone.folder);
	if (sameList) {
		const siblings = (origin as { siblings: string[] }).siblings;
		const after = moveBefore(siblings, room, before);
		if (after.every((key, at) => key === siblings[at])) return undefined;
	}
	return zone.kind === "pinned"
		? { kind: "pin", before }
		: { kind: "folder", folder: zone.folder as string, before };
}

/**
 * A folder dragged by its header: `headers` are the folders' header boxes in order, and `bounds` the
 * space the folder list fills. The folder lands before the first header whose middle is below the
 * finger; a finger well outside the list cancels (undefined).
 */
export function resolveFolderDrop(
	headers: readonly ItemBox[],
	bounds: { top: number; bottom: number },
	dragged: string,
	y: number,
): { before: string | null } | undefined {
	if (y < bounds.top - ZONE_SLACK * 3 || y > bounds.bottom + ZONE_SLACK * 3)
		return undefined;
	return { before: beforeAt(headers, dragged, y) };
}

/**
 * How far each of the other items moves to make room while `from` is dragged to land at `to` (an
 * index among all items as they will stand after the drop). `gap` is the space between items.
 */
export function shifts(
	boxes: readonly Box[],
	from: number,
	to: number,
	gap = 0,
): number[] {
	const moving = (boxes[from]?.height ?? 0) + gap;
	return boxes.map((_, i) => {
		if (i === from) return 0;
		if (from < to && i > from && i <= to) return -moving;
		if (from > to && i >= to && i < from) return moving;
		return 0;
	});
}

/** The index a dragged item lands at among the items, from the key it goes before. */
export function landing(
	keys: readonly string[],
	dragged: string,
	before: string | null,
): number {
	return moveBefore(keys, dragged, before).indexOf(dragged);
}

/**
 * How many px to scroll per frame for a finger at `y` in a view from `top` to `bottom`: negative near the
 * top edge, positive near the bottom, faster the closer to it; none in the middle.
 */
export function scrollStep(
	y: number,
	top: number,
	bottom: number,
	edge = 64,
	fastest = 18,
): number {
	if (y < top + edge) return -Math.min(1, (top + edge - y) / edge) * fastest;
	if (y > bottom - edge)
		return Math.min(1, (y - (bottom - edge)) / edge) * fastest;
	return 0;
}

/** How long a finger rests on a folded folder before it opens, in ms. */
export const HOVER_OPEN_MS = 600;
