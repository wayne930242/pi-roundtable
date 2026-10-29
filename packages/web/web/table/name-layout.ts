/**
 * Where the names over the podiums stand once they are kept clear of each other, as plain numbers so
 * the layout is tested without a page. A name belongs over its podium's plate, but a ring of many
 * seats seen from across the hall puts the plates closer together than the names are wide: a name
 * then slides to the nearest free place beside the names already there, or steps up or down a whole row, and is kept inside the picture. The names nearest the camera (lowest in the picture) keep their own places.
 */

/** A name's centre and size on the screen, in CSS px. */
export interface NameSpot {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The picture the names stand in, in CSS px. */
export interface NameBounds {
	width: number;
	height: number;
}

/** The space left between two names, and between a name and the picture's edge. */
export const NAME_GAP = 2;
/** How many rows a name may step away from its plate, each way. */
export const MAX_ROWS = 4;

export interface NameLayout {
	/** Each name's centre after the layout, in the order given. */
	spots: Array<{ x: number; y: number }>;
	/** Whether every name stands clear of the others. */
	clear: boolean;
}

const overlaps = (
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
): boolean =>
	Math.abs(a.x - b.x) < (a.w + b.w) / 2 + NAME_GAP &&
	Math.abs(a.y - b.y) < (a.h + b.h) / 2 + NAME_GAP;

const clamp = (value: number, low: number, high: number): number =>
	high < low ? (low + high) / 2 : Math.min(high, Math.max(low, value));

/** Where `name` stands without touching one of `placed`, the nearest such place to its plate; undefined when none is free. */
function standClear(
	name: NameSpot,
	placed: readonly NameSpot[],
	bounds: NameBounds,
): NameSpot | undefined {
	const low = name.w / 2 + NAME_GAP;
	const high = bounds.width - name.w / 2 - NAME_GAP;
	// across: its own column, or just beside a name already there (the nearest it can slide to)
	const columns = [
		name.x,
		...placed.flatMap((other) => [
			other.x - (other.w + name.w) / 2 - NAME_GAP,
			other.x + (other.w + name.w) / 2 + NAME_GAP,
		]),
	].map((x) => clamp(x, low, high));
	// up and down: its own row, or a whole row away
	const rows = Array.from(
		{ length: MAX_ROWS * 2 + 1 },
		(_, i) => name.y + (i - MAX_ROWS) * (name.h + NAME_GAP),
	).filter((y) => y >= name.h / 2 && y <= bounds.height - name.h / 2);
	let best: NameSpot | undefined;
	let cost = Number.POSITIVE_INFINITY;
	for (const x of columns)
		for (const y of rows) {
			// a step up or down costs more than a slide: a name stays in its column if it can
			const away = Math.hypot(x - name.x, (y - name.y) * 1.5);
			if (away >= cost) continue;
			const candidate = { x, y, w: name.w, h: name.h };
			if (placed.some((other) => overlaps(candidate, other))) continue;
			best = candidate;
			cost = away;
		}
	return best;
}

export function spreadNames(
	names: readonly NameSpot[],
	bounds: NameBounds,
): NameLayout {
	const spots = names.map(({ x, y }) => ({ x, y }));
	const placed: NameSpot[] = [];
	let clear = true;
	// the lowest name first: it is the nearest to the camera, and the ones behind it make way
	const order = names
		.map((_, i) => i)
		.sort(
			(i, j) =>
				(names[j]?.y ?? 0) - (names[i]?.y ?? 0) ||
				(names[i]?.x ?? 0) - (names[j]?.x ?? 0) ||
				i - j,
		);
	for (const index of order) {
		const name = names[index];
		if (!name) continue;
		const found = standClear(name, placed, bounds);
		if (!found) clear = false;
		const stood = found ?? name;
		placed.push(stood);
		spots[index] = { x: stood.x, y: stood.y };
	}
	return { spots, clear };
}
