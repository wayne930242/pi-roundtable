/**
 * Where the names over the podiums stand once they are kept clear of each other and of the figures'
 * faces, as plain numbers so the layout is tested without a page. A name belongs over its podium's
 * plate, but a ring of many seats seen from across the hall puts the plates closer together than the
 * names are wide, and a rear podium's plate lands on the standee in front of it. A name then slides
 * to the nearest free place: beside the names already there, past a face, or a row up or down, and is
 * kept inside the picture. The names nearest the camera (lowest in the picture) keep their own places.
 */

/** A name's centre and size on the screen, in CSS px. */
export interface NameSpot {
	x: number;
	y: number;
	w: number;
	h: number;
	/** The place just over its own standee's head: where a name that cannot stand on its plate reads best, as the standee's own name tag. */
	above?: { x: number; y: number };
}

/** A face on the screen that no name may cover: a centre and size, in CSS px. */
export type Face = NameSpot;

/** The picture the names stand in, in CSS px. */
export interface NameBounds {
	width: number;
	height: number;
}

/** The space left between two names, and between a name and the picture's edge. */
export const NAME_GAP = 2;
/** What a place over the name's own standee costs beyond its distance from there, in px: a name leaves its plate for the standee's head before it wanders far along the floor. */
const ABOVE_COST = 40;

export interface NameLayout {
	/** Each name's centre after the layout, in the order given. */
	spots: Array<{ x: number; y: number }>;
	/** Whether every name stands clear of the others. */
	clear: boolean;
	/** How many names are left over a face because no place was free of both. */
	covering: number;
}

const overlaps = (
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
): boolean =>
	Math.abs(a.x - b.x) < (a.w + b.w) / 2 + NAME_GAP &&
	Math.abs(a.y - b.y) < (a.h + b.h) / 2 + NAME_GAP;

const clamp = (value: number, low: number, high: number): number =>
	high < low ? (low + high) / 2 : Math.min(high, Math.max(low, value));

/** Where `name` stands without touching one of `placed` or `faces`, the nearest such place to its plate; undefined when none is free. */
function standClear(
	name: NameSpot,
	placed: readonly NameSpot[],
	faces: readonly Face[],
	bounds: NameBounds,
): NameSpot | undefined {
	const low = name.w / 2 + NAME_GAP;
	const high = bounds.width - name.w / 2 - NAME_GAP;
	const top = name.h / 2;
	const bottom = bounds.height - name.h / 2;
	const blockers = [...placed, ...faces];
	// across: its own column, or just beside something already there (the nearest it can slide to)
	const columns = [
		name.x,
		...(name.above ? [name.above.x] : []),
		...blockers.flatMap((other) => [
			other.x - (other.w + name.w) / 2 - NAME_GAP,
			other.x + (other.w + name.w) / 2 + NAME_GAP,
		]),
	].map((x) => clamp(x, low, high));
	// up and down: its own row, or just past something already there
	const rows = [
		name.y,
		...(name.above ? [name.above.y] : []),
		...blockers.flatMap((other) => [
			other.y - (other.h + name.h) / 2 - NAME_GAP,
			other.y + (other.h + name.h) / 2 + NAME_GAP,
		]),
	].filter((y) => y >= top && y <= bottom);
	let best: NameSpot | undefined;
	let cost = Number.POSITIVE_INFINITY;
	for (const x of columns)
		for (const y of rows) {
			// a step up or down costs more than a slide: a name stays in its column if it can
			const above = name.above;
			const away = Math.min(
				Math.hypot(x - name.x, (y - name.y) * 1.5),
				above
					? Math.hypot(x - above.x, (y - above.y) * 1.5) + ABOVE_COST
					: Number.POSITIVE_INFINITY,
			);
			if (away >= cost) continue;
			const candidate = { x, y, w: name.w, h: name.h };
			if (blockers.some((other) => overlaps(candidate, other))) continue;
			best = candidate;
			cost = away;
		}
	return best;
}

export function spreadNames(
	names: readonly NameSpot[],
	bounds: NameBounds,
	faces: readonly Face[] = [],
): NameLayout {
	const spots = names.map(({ x, y }) => ({ x, y }));
	const placed: NameSpot[] = [];
	let clear = true;
	let covering = 0;
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
		// clear of the faces too if there is room; failing that, clear of the other names at least
		let found = standClear(name, placed, faces, bounds);
		if (!found) {
			found = standClear(name, placed, [], bounds);
			if (found && faces.some((face) => overlaps(found as NameSpot, face)))
				covering += 1;
		}
		if (!found) clear = false;
		const stood = found ?? name;
		placed.push(stood);
		spots[index] = { x: stood.x, y: stood.y };
	}
	return { spots, clear, covering };
}
