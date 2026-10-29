/**
 * Seat name labels. A name is shown whole while it fits the plate and cut with an ellipsis only when it
 * is longer than the plate, so a long name never runs past its plate.
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
