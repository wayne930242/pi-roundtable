import { CharacterError, checkHex, type Hex } from "./spec.ts";

/** How many skin tones a set holds: `CharacterSpec.skin` is an index from 0 to 5. */
const SKIN_COUNT = 6;

/**
 * Six light East Asian skin tones, from very fair porcelain to light beige, for a host whose
 * agents should read that way: `characters: { skins: EAST_ASIAN_SKINS }` in the configuration.
 * Every tone leans pink to peach, never green or yellow, and the face lines read on each at 5:1
 * or more. Stored looks keep their skin index, so they take the new tones as they are.
 */
export const EAST_ASIAN_SKINS: readonly Hex[] = Object.freeze([
	"#fbebe0",
	"#f8e1d2",
	"#f5d8c5",
	"#f1cfb8",
	"#edc6ac",
	"#e9bf9f",
]);

/**
 * A host's skin tones checked: exactly six `#rrggbb` colors, light to dark by convention, in the
 * order `CharacterSpec.skin` indexes them. Returns them lower-cased and frozen; `field` names the
 * setting in the error.
 */
export function checkSkins(value: unknown, field = "skins"): readonly Hex[] {
	if (!Array.isArray(value) || value.length !== SKIN_COUNT)
		throw new CharacterError(
			field,
			`must be a list of exactly ${SKIN_COUNT} #rrggbb colors`,
		);
	return Object.freeze(
		// Array.from, not map: map skips the holes of a sparse list, which would pass unchecked.
		Array.from(value, (hex, index) => checkHex(hex, `${field}[${index}]`)),
	);
}
