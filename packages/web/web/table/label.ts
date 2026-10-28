/**
 * Seat name labels. A name is shown whole while it fits the plate and cut with an ellipsis only when it
 * is longer than the plate, so a long name never runs under the table or past its plate.
 */

/** The width of a glyph in em: CJK and full-width forms are square, the rest about 0.6. */
const glyphEm = (char: string): number => {
	const code = char.codePointAt(0) ?? 0;
	return code >= 0x2e80 && code <= 0xfaff
		? 1
		: code >= 0xff00 && code <= 0xffef
			? 1
			: 0.6;
};

/** The text as it fits `fits`, which says whether a string is short enough; the whole name when it already is. */
export function ellipsize(
	name: string,
	fits: (text: string) => boolean,
): string {
	if (fits(name)) return name;
	const glyphs = Array.from(name);
	while (glyphs.length > 1) {
		glyphs.pop();
		const cut = `${glyphs.join("").trimEnd()}…`;
		if (fits(cut)) return cut;
	}
	return "…";
}

/** The name cut to `maxEm` of room, by an estimate of its width; for the SVG table, which cannot measure text. */
export function fitLabel(name: string, maxEm: number): string {
	const width = (text: string) =>
		Array.from(text).reduce((sum, char) => sum + glyphEm(char), 0);
	return ellipsize(name, (text) => width(text) <= maxEm);
}

/** The smallest a seat name may be drawn on the screen, in CSS px. */
export const MIN_NAME_PX = 11;
/** The size a name is drawn at where there is room to grow the plate for it; `MIN_NAME_PX` is the least that still counts as readable. */
const TARGET_NAME_PX = 13.5;
/** How much room a plate needs from its neighbours (as a multiple of its own size) before it is grown past what a readable name takes. */
const GENEROUS_ROOM = 1.6;
/** The most a name plate is enlarged. */
const MAX_PLATE_SCALE = 2;

export interface PlateFacts {
	/** CSS px one world unit spans at the seats' depth. */
	pxPerUnit: number;
	/** A plate's width in world units at scale 1. */
	plateWidth: number;
	/** The world distance between two neighbouring seats. */
	gap: number;
	/** The name's font size in plate-texture px when it fits whole, and the texture's width of a plate. */
	fontCell: number;
	cellWidth: number;
}

export interface PlatePlan {
	/** How many times larger than its base size a plate stands. */
	scale: number;
	/** Whether the plate carries the name; false once even the largest plate that clears its neighbours is below `MIN_NAME_PX`. */
	names: boolean;
	/** The name's size on the screen with that scale, in CSS px. */
	px: number;
}

/**
 * Plates grow with the canvas' own scale so a name stays at least `MIN_NAME_PX` where the neighbours
 * leave room; where they do not, the plate is left without a name (the page lists the seats instead)
 * rather than carrying one too small to read.
 */
export function planPlates(facts: PlateFacts): PlatePlan {
	const base =
		(facts.fontCell / facts.cellWidth) * facts.plateWidth * facts.pxPerUnit;
	if (!(base > 0)) return { scale: 1, names: false, px: 0 };
	const room = Math.max(
		1,
		Math.min(MAX_PLATE_SCALE, (0.95 * facts.gap) / facts.plateWidth),
	);
	// In a crowded ring a plate grows only as far as a readable name takes, so it covers its neighbours' badges as little as it can.
	const want = room >= GENEROUS_ROOM ? TARGET_NAME_PX : MIN_NAME_PX * 1.02;
	const scale = Math.min(room, Math.max(1, want / base));
	const px = base * scale;
	return { scale, names: px >= MIN_NAME_PX - 1e-6, px };
}

/**
 * The order plates are drawn in, far to near: `depth` is how far each seat stands toward the camera,
 * so a plate of a nearer seat is never covered by a farther one's. Returns the seat index per slot.
 */
export function plateOrder(depth: readonly number[]): number[] {
	return depth
		.map((value, index) => ({ value, index }))
		.sort((a, b) => a.value - b.value || a.index - b.index)
		.map((entry) => entry.index);
}

/**
 * How far a seat's picture is raised so its head clears the table's far edge: nothing for a seat at
 * the near side or at the sides, up to `max` for the seat straight across. `toward` is the seat's
 * distance toward the camera over the ring's radius, from -1 (far side) to 1 (near side).
 */
export function rearLift(toward: number, max: number): number {
	const far = Math.min(1, Math.max(0, -toward));
	return max * far * far;
}
