import {
	type AvatarState,
	CATALOG,
	type CharacterInput,
	type CharacterSpec,
	CLASS_IDS,
	type PaletteName,
} from "pi-roundtable/characters";
import { translate as t, wording } from "../lib/messages.ts";

/** The fields a part strip changes. */
export type PartField =
	| "hat"
	| "outfit"
	| "prop"
	| "hair"
	| "beard"
	| "accessory";

export const PARTS: {
	field: PartField;
	title: string;
	ids: readonly string[];
}[] = [
	{ field: "hat", title: wording("Hat"), ids: CATALOG.hats },
	{ field: "outfit", title: wording("Outfit"), ids: CATALOG.outfits },
	{ field: "prop", title: wording("Prop"), ids: CATALOG.props },
	{ field: "hair", title: wording("Hair"), ids: CATALOG.hair },
	{ field: "beard", title: wording("Beard"), ids: ["none", ...CATALOG.beards] },
	{
		field: "accessory",
		title: wording("Accessory"),
		ids: ["none", ...CATALOG.accessories],
	},
];

/** The fields the form renders an error under; any other field a server names is reported in the general slot. */
export const RENDERED_FIELDS: ReadonlySet<string> = new Set([
	"class",
	"colors",
	"palette",
	"build",
	"skin",
	"hairColor",
	...PARTS.map((part) => part.field),
]);

export const PALETTES = Object.keys(CATALOG.palettes) as PaletteName[];

export const STATE_LABELS: Record<AvatarState, string> = {
	idle: wording("Idle"),
	thinking: wording("Thinking"),
	working: wording("Working"),
	waiting: wording("Waiting for you"),
	done: wording("Done"),
	error: wording("Error"),
	sleepy: wording("Sleepy"),
};

export const BUILD_LABELS: Record<CharacterSpec["build"], string> = {
	slim: wording("Slim"),
	regular: wording("Regular"),
	stout: wording("Stout"),
};

/** The fields the server takes, from a spec; `palette` is left to the server to work out from the colors. */
export function inputOf(spec: CharacterSpec): CharacterInput {
	return {
		class: spec.class,
		outfit: spec.outfit,
		hat: spec.hat,
		prop: spec.prop,
		hair: spec.hair,
		beard: spec.beard,
		accessory: spec.accessory,
		build: spec.build,
		skin: spec.skin,
		hairColor: spec.hairColor,
		colors: { ...spec.colors },
	};
}

/** A spec as a string that is the same for the same look, to tell a change from none. */
export const canon = (spec: CharacterSpec): string =>
	JSON.stringify(inputOf(spec));

const pick = <T>(list: readonly T[]): T =>
	list[Math.floor(Math.random() * list.length)] as T;

/** A random look from the catalog. */
export function randomInput(): CharacterInput {
	return {
		class: pick(CLASS_IDS),
		outfit: pick(CATALOG.outfits),
		hat: pick(CATALOG.hats),
		prop: pick(CATALOG.props),
		hair: pick(CATALOG.hair),
		beard: pick(["none", ...CATALOG.beards] as const),
		accessory: pick(["none", ...CATALOG.accessories] as const),
		build: pick(["slim", "regular", "stout"] as const),
		skin: pick([0, 1, 2, 3, 4, 5] as const),
		hairColor: pick(CATALOG.hairColors),
		palette: pick(PALETTES),
	};
}
export const characterLabelBuild = (build: CharacterSpec["build"]) =>
	t(BUILD_LABELS[build]);
