import {
	ACCESSORY_CHOICES,
	BEARD_CHOICES,
	BUILDS,
	CATALOG,
	CLASS_IDS,
	HAIR_IDS,
	HAT_IDS,
	OUTFIT_IDS,
	PROP_IDS,
	SKIN_INDEXES,
} from "./catalog.ts";
import {
	type CharacterColors,
	CharacterError,
	type CharacterSpec,
	checkHex,
	checkOneOf,
	isRecord,
	paletteOf,
	presetSpec,
} from "./spec.ts";

const SPEC_KEYS = new Set([
	"v",
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
const REQUIRED_KEYS = [...SPEC_KEYS].filter((key) => key !== "palette");
const COLOR_KEYS = ["primary", "secondary", "trim"] as const;

function requireField(object: Record<string, unknown>, field: string): void {
	if (!Object.hasOwn(object, field))
		throw new CharacterError(field, "is required");
}

/**
 * A complete spec from outside the process (an API body, what the page received), checked
 * strictly: an unknown key or id, a missing field, or a color that is not `#rrggbb` throws a
 * `CharacterError` naming the field. Colors are lowercased.
 */
export function parseCharacter(value: unknown): CharacterSpec {
	if (!isRecord(value))
		throw new CharacterError("character", "must be an object");
	for (const key of Object.keys(value))
		if (!SPEC_KEYS.has(key))
			throw new CharacterError(key, "is not a known field");
	for (const key of REQUIRED_KEYS) requireField(value, key);
	if (value.v !== 1) throw new CharacterError("v", "must be 1");
	const colorsIn = value.colors;
	if (!isRecord(colorsIn))
		throw new CharacterError("colors", "must be an object");
	for (const key of Object.keys(colorsIn))
		if (!(COLOR_KEYS as readonly string[]).includes(key))
			throw new CharacterError(`colors.${key}`, "is not a known color");
	for (const key of COLOR_KEYS) requireField(colorsIn, key);
	const colors: CharacterColors = {
		primary: checkHex(colorsIn.primary, "colors.primary"),
		secondary: checkHex(colorsIn.secondary, "colors.secondary"),
		trim: checkHex(colorsIn.trim, "colors.trim"),
	};
	const palette = paletteOf(colors);
	if (value.palette !== undefined) {
		const named = checkOneOf(
			Object.keys(CATALOG.palettes),
			value.palette,
			"palette",
		);
		if (named !== palette)
			throw new CharacterError("palette", "does not match the colors");
	}
	return {
		v: 1,
		class: checkOneOf(CLASS_IDS, value.class, "class"),
		outfit: checkOneOf(OUTFIT_IDS, value.outfit, "outfit"),
		hat: checkOneOf(HAT_IDS, value.hat, "hat"),
		prop: checkOneOf(PROP_IDS, value.prop, "prop"),
		hair: checkOneOf(HAIR_IDS, value.hair, "hair"),
		beard: checkOneOf(BEARD_CHOICES, value.beard, "beard"),
		accessory: checkOneOf(ACCESSORY_CHOICES, value.accessory, "accessory"),
		build: checkOneOf(BUILDS, value.build, "build"),
		skin: checkOneOf(SKIN_INDEXES, value.skin, "skin"),
		hairColor: checkHex(value.hairColor, "hairColor"),
		colors,
		...(palette ? { palette } : {}),
	};
}

/** The value if `check` accepts it, else `fallback`. */
function lenient<T>(check: () => T, fallback: T): T {
	try {
		return check();
	} catch (error) {
		if (error instanceof CharacterError) return fallback;
		throw error;
	}
}

/**
 * A spec from a stored row, read leniently so an old row, or one a newer version wrote, never
 * throws: a field that is not valid here (an id this version does not know, a bad color) takes
 * the class preset's value, and an unknown key is ignored. `undefined` when the value is not an
 * object or names no known class.
 */
export function readCharacter(value: unknown): CharacterSpec | undefined {
	if (!isRecord(value)) return undefined;
	const id = lenient(
		() => checkOneOf(CLASS_IDS, value.class, "class"),
		undefined,
	);
	if (!id) return undefined;
	const spec = presetSpec(id);
	const take = <T>(check: () => T, set: (found: T) => void) => {
		const none = Symbol("none");
		const found = lenient<T | typeof none>(check, none);
		if (found !== none) set(found as T);
	};
	take(
		() => checkOneOf(OUTFIT_IDS, value.outfit, "outfit"),
		(found) => {
			spec.outfit = found;
		},
	);
	take(
		() => checkOneOf(HAT_IDS, value.hat, "hat"),
		(found) => {
			spec.hat = found;
		},
	);
	take(
		() => checkOneOf(PROP_IDS, value.prop, "prop"),
		(found) => {
			spec.prop = found;
		},
	);
	take(
		() => checkOneOf(HAIR_IDS, value.hair, "hair"),
		(found) => {
			spec.hair = found;
		},
	);
	take(
		() => checkOneOf(BEARD_CHOICES, value.beard, "beard"),
		(found) => {
			spec.beard = found;
		},
	);
	take(
		() => checkOneOf(ACCESSORY_CHOICES, value.accessory, "accessory"),
		(found) => {
			spec.accessory = found;
		},
	);
	take(
		() => checkOneOf(BUILDS, value.build, "build"),
		(found) => {
			spec.build = found;
		},
	);
	take(
		() => checkOneOf(SKIN_INDEXES, value.skin, "skin"),
		(found) => {
			spec.skin = found;
		},
	);
	take(
		() => checkHex(value.hairColor, "hairColor"),
		(found) => {
			spec.hairColor = found;
		},
	);
	if (isRecord(value.colors)) {
		const colors = value.colors;
		for (const key of COLOR_KEYS)
			take(
				() => checkHex(colors[key], `colors.${key}`),
				(found) => {
					spec.colors[key] = found;
				},
			);
	}
	const palette = paletteOf(spec.colors);
	if (palette) spec.palette = palette;
	else delete spec.palette;
	return spec;
}
