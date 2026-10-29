// Composed characters: a part library and an SVG composer that run in the browser and on the server.

export type {
	AccessoryId,
	AvatarState,
	BeardId,
	ClassId,
	Expression,
	HairId,
	HatId,
	OutfitId,
	PropId,
} from "./catalog.ts";
export {
	AVATAR_STATES,
	CATALOG,
	CLASS_IDS,
	EXPRESSIONS,
	STATE_EXPRESSION,
} from "./catalog.ts";
export type { CharacterLook, ComposeOptions } from "./compose.ts";
export { accentOf, composeSvg } from "./compose.ts";
export { characterCss } from "./css.ts";
export { parseCharacter, readCharacter } from "./parse.ts";
export { checkSkins, EAST_ASIAN_SKINS } from "./skins.ts";
export type {
	CharacterColors,
	CharacterInput,
	CharacterSpec,
	Hex,
	PaletteName,
} from "./spec.ts";
export { CharacterError, resolveCharacter } from "./spec.ts";
export { suggestCharacter } from "./suggest.ts";
