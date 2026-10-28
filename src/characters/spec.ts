import {
	ACCESSORY_CHOICES,
	type AccessoryId,
	BEARD_CHOICES,
	type BeardId,
	BUILDS,
	CATALOG,
	CLASS_IDS,
	type ClassId,
	HAIR_IDS,
	HAT_IDS,
	type HairId,
	type HatId,
	OUTFIT_IDS,
	type OutfitId,
	PROP_IDS,
	type PropId,
	SKIN_INDEXES,
} from "./catalog.ts";

/** A lowercase `#rrggbb` color. */
export type Hex = `#${string}`;
export type PaletteName =
	| "azure"
	| "gules"
	| "vert"
	| "purpure"
	| "amber"
	| "sable"
	| "teal"
	| "rose";

export interface CharacterColors {
	/** The agent accent. */
	primary: Hex;
	secondary: Hex;
	trim: Hex;
}

/** An agent's look, fully resolved. */
export interface CharacterSpec {
	v: 1;
	class: ClassId;
	outfit: OutfitId;
	hat: HatId;
	prop: PropId;
	hair: HairId;
	beard: BeardId | "none";
	accessory: AccessoryId | "none";
	build: "slim" | "regular" | "stout";
	skin: 0 | 1 | 2 | 3 | 4 | 5;
	hairColor: Hex;
	colors: CharacterColors;
	/** Set when `colors` equal a preset. */
	palette?: PaletteName;
}

export type CharacterInput = Partial<
	Omit<CharacterSpec, "v" | "colors" | "palette">
> & { palette?: PaletteName; colors?: Partial<CharacterColors> };

/** A character that cannot be made; `field` is the path of the offending field. */
export class CharacterError extends Error {
	readonly field: string;
	constructor(field: string, message: string) {
		super(`${field}: ${message}`);
		this.name = "CharacterError";
		this.field = field;
	}
}

const HEX = /^#[0-9a-f]{6}$/;

export function checkHex(value: unknown, field: string): Hex {
	if (typeof value !== "string")
		throw new CharacterError(field, "must be a #rrggbb color");
	const lower = value.toLowerCase();
	if (!HEX.test(lower))
		throw new CharacterError(field, "must be a #rrggbb color");
	return lower as Hex;
}

export function checkOneOf<T extends string | number>(
	list: readonly T[],
	value: unknown,
	field: string,
): T {
	const found = list.find((item) => item === value);
	if (found === undefined)
		throw new CharacterError(
			field,
			`must be one of ${list.map(String).join(", ")}`,
		);
	return found;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** The palette whose three colors these are, if any. */
export function paletteOf(colors: CharacterColors): PaletteName | undefined {
	for (const [name, preset] of Object.entries(CATALOG.palettes))
		if (
			preset.primary === colors.primary &&
			preset.secondary === colors.secondary &&
			preset.trim === colors.trim
		)
			return name as PaletteName;
	return undefined;
}

/** A fresh copy of a class's preset. */
export function presetSpec(id: ClassId): CharacterSpec {
	const preset = CATALOG.classes[id].preset;
	return {
		v: 1,
		class: id,
		outfit: preset.outfit,
		hat: preset.hat,
		prop: preset.prop,
		hair: preset.hair,
		beard: preset.beard,
		accessory: preset.accessory,
		build: preset.build,
		skin: preset.skin,
		hairColor: preset.hairColor,
		colors: { ...preset.colors },
		...(preset.palette ? { palette: preset.palette } : {}),
	};
}

const INPUT_KEYS = new Set([
	"class",
	"outfit",
	"hat",
	"prop",
	"hair",
	"beard",
	"accessory",
	"build",
	"skin",
	"hairColor",
	"colors",
	"palette",
]);
const COLOR_KEYS = ["primary", "secondary", "trim"] as const;

/** Set `colors` and `palette` on `spec` from a palette name and/or partial colors. */
function applyColors(
	spec: CharacterSpec,
	palette: unknown,
	colors: unknown,
): void {
	if (palette !== undefined) {
		const name = checkOneOf(Object.keys(CATALOG.palettes), palette, "palette");
		spec.colors = { ...CATALOG.palettes[name as PaletteName] };
	}
	if (colors !== undefined) {
		if (!isRecord(colors))
			throw new CharacterError("colors", "must be an object");
		for (const key of Object.keys(colors))
			if (!(COLOR_KEYS as readonly string[]).includes(key))
				throw new CharacterError(`colors.${key}`, "is not a known color");
		const next = { ...spec.colors };
		for (const key of COLOR_KEYS)
			if (colors[key] !== undefined)
				next[key] = checkHex(colors[key], `colors.${key}`);
		spec.colors = next;
	}
	const name = paletteOf(spec.colors);
	if (name) spec.palette = name;
	else delete spec.palette;
}

/**
 * The look an input describes: `base` (or the input's class preset when there is no base or the
 * input changes the class), then the input's fields over it.
 */
export function resolveCharacter(
	input: CharacterInput,
	base?: CharacterSpec,
): CharacterSpec {
	if (!isRecord(input))
		throw new CharacterError("character", "must be an object");
	for (const key of Object.keys(input))
		if (!INPUT_KEYS.has(key))
			throw new CharacterError(key, "is not a known field");
	const id =
		input.class === undefined
			? base?.class
			: checkOneOf(CLASS_IDS, input.class, "class");
	if (!id) throw new CharacterError("class", "is required");
	const spec: CharacterSpec =
		base && base.class === id
			? { ...base, colors: { ...base.colors } }
			: presetSpec(id);
	if (input.outfit !== undefined)
		spec.outfit = checkOneOf(OUTFIT_IDS, input.outfit, "outfit");
	if (input.hat !== undefined) spec.hat = checkOneOf(HAT_IDS, input.hat, "hat");
	if (input.prop !== undefined)
		spec.prop = checkOneOf(PROP_IDS, input.prop, "prop");
	if (input.hair !== undefined)
		spec.hair = checkOneOf(HAIR_IDS, input.hair, "hair");
	if (input.beard !== undefined)
		spec.beard = checkOneOf(BEARD_CHOICES, input.beard, "beard");
	if (input.accessory !== undefined)
		spec.accessory = checkOneOf(
			ACCESSORY_CHOICES,
			input.accessory,
			"accessory",
		);
	if (input.build !== undefined)
		spec.build = checkOneOf(BUILDS, input.build, "build");
	if (input.skin !== undefined)
		spec.skin = checkOneOf(SKIN_INDEXES, input.skin, "skin");
	if (input.hairColor !== undefined)
		spec.hairColor = checkHex(input.hairColor, "hairColor");
	applyColors(spec, input.palette, input.colors);
	return spec;
}
