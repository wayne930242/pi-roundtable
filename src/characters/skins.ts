import { CharacterError, checkHex, type Hex } from "./spec.ts";

/** How many skin tones a set holds: `CharacterSpec.skin` is an index from 0 to 5. */
const SKIN_COUNT = 6;

/**
 * Six light East Asian skin tones, from very fair porcelain to light wheat, for a host whose
 * agents should read that way: `characters: { skins: EAST_ASIAN_SKINS }` in the configuration.
 * Every tone leans pink to peach, never green or yellow, and the face lines read on each at 6:1
 * or more. Stored looks keep their skin index, so they take the new tones as they are.
 */
export const EAST_ASIAN_SKINS: readonly Hex[] = Object.freeze([
	"#f8dfcd",
	"#f2d1ba",
	"#ebc3a7",
	"#e3b396",
	"#d9a285",
	"#cc9272",
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
		value.map((hex, index) => checkHex(hex, `${field}[${index}]`)),
	);
}
