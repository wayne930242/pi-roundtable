import { type ClassEntry, HAIR_COLORS, PALETTES, SKINS } from "./class-data.ts";
import { CLASSES_A } from "./classes-a.ts";
import { CLASSES_B } from "./classes-b.ts";
import { CLASSES_C } from "./classes-c.ts";
import type {
	CharacterColors,
	CharacterSpec,
	Hex,
	PaletteName,
} from "./spec.ts";

/** Freeze a value and everything reachable from it, so a shared catalog cannot be edited. */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

export const CLASS_IDS = [
	"wizard",
	"knight",
	"scholar",
	"smith",
	"ranger",
	"bard",
	"alchemist",
	"healer",
	"steward",
	"navigator",
	"seer",
	"scribe",
	"engineer",
	"druid",
	"innkeeper",
	"sentinel",
	"envoy",
	"rogue",
	"monk",
	"falconer",
	"shipwright",
	"jester",
	"paladin",
	"archivist",
] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export type OutfitId =
	| "robe"
	| "scholar"
	| "armor"
	| "plate"
	| "apron"
	| "chef"
	| "cloak"
	| "tunic"
	| "coat"
	| "overalls"
	| "vest"
	| "habit"
	| "surplice"
	| "motley"
	| "sailor";
export const OUTFIT_IDS: readonly OutfitId[] = [
	"robe",
	"scholar",
	"armor",
	"plate",
	"apron",
	"chef",
	"cloak",
	"tunic",
	"coat",
	"overalls",
	"vest",
	"habit",
	"surplice",
	"motley",
	"sailor",
];

export type HatId =
	| "none"
	| "wizard"
	| "helm"
	| "mortar"
	| "goggcap"
	| "hood"
	| "beret"
	| "goggles"
	| "coif"
	| "tallcap"
	| "tricorn"
	| "turban"
	| "softcap"
	| "hardhat"
	| "wreath"
	| "toque"
	| "kettle"
	| "cavalier"
	| "cowl"
	| "headband"
	| "fcap"
	| "sailor"
	| "jester"
	| "winghelm";
export const HAT_IDS: readonly HatId[] = [
	"none",
	"wizard",
	"helm",
	"mortar",
	"goggcap",
	"hood",
	"beret",
	"goggles",
	"coif",
	"tallcap",
	"tricorn",
	"turban",
	"softcap",
	"hardhat",
	"wreath",
	"toque",
	"kettle",
	"cavalier",
	"cowl",
	"headband",
	"fcap",
	"sailor",
	"jester",
	"winghelm",
];

export type PropId =
	| "staff"
	| "shield"
	| "scroll"
	| "hammer"
	| "bow"
	| "lute"
	| "flask"
	| "quill"
	| "tome"
	| "bell"
	| "keys"
	| "map"
	| "telescope"
	| "wrench"
	| "spade"
	| "ladle"
	| "lantern"
	| "seal"
	| "dagger"
	| "beads"
	| "bird"
	| "anchor"
	| "marotte"
	| "sword";
export const PROP_IDS: readonly PropId[] = [
	"staff",
	"shield",
	"scroll",
	"hammer",
	"bow",
	"lute",
	"flask",
	"quill",
	"tome",
	"bell",
	"keys",
	"map",
	"telescope",
	"wrench",
	"spade",
	"ladle",
	"lantern",
	"seal",
	"dagger",
	"beads",
	"bird",
	"anchor",
	"marotte",
	"sword",
];

export type HairId =
	| "none"
	| "short"
	| "bob"
	| "long"
	| "bun"
	| "curly"
	| "ponytail"
	| "braid";
export const HAIR_IDS: readonly HairId[] = [
	"none",
	"short",
	"bob",
	"long",
	"bun",
	"curly",
	"ponytail",
	"braid",
];

export type BeardId = "full" | "mustache" | "goatee";
const BEARD_IDS: readonly BeardId[] = ["full", "mustache", "goatee"];
export const BEARD_CHOICES: readonly (BeardId | "none")[] = [
	...BEARD_IDS,
	"none",
];

export type AccessoryId = "glasses" | "freckles" | "scar";
const ACCESSORY_IDS: readonly AccessoryId[] = ["glasses", "freckles", "scar"];
export const ACCESSORY_CHOICES: readonly (AccessoryId | "none")[] = [
	...ACCESSORY_IDS,
	"none",
];

export const BUILDS: readonly CharacterSpec["build"][] = [
	"slim",
	"regular",
	"stout",
];

export const SKIN_INDEXES: readonly CharacterSpec["skin"][] = [
	0, 1, 2, 3, 4, 5,
];

export const EXPRESSIONS = [
	"neutral",
	"happy",
	"thinking",
	"concerned",
	"apologetic",
	"surprised",
	"proud",
	"amused",
	"curious",
	"sympathetic",
	"playful",
	"determined",
	"sleepy",
	"resting",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const AVATAR_STATES = [
	"idle",
	"thinking",
	"working",
	"waiting",
	"done",
	"error",
	"sleepy",
] as const;
export type AvatarState = (typeof AVATAR_STATES)[number];

export const STATE_EXPRESSION: Readonly<Record<AvatarState, Expression>> =
	deepFreeze({
		idle: "neutral",
		thinking: "thinking",
		working: "determined",
		waiting: "curious",
		done: "proud",
		error: "apologetic",
		sleepy: "sleepy",
	});

const CLASSES: Record<ClassId, ClassEntry> = {
	...CLASSES_A,
	...CLASSES_B,
	...CLASSES_C,
};

export const CATALOG: Readonly<{
	classes: Readonly<
		Record<
			ClassId,
			Readonly<{
				label: string;
				/** The agent jobs the class suits. */
				jobs: string;
				/** English and zh-TW words that suggest the class from an agent's name and prompt. */
				keywords: readonly string[];
				preset: Omit<CharacterSpec, "v" | "class">;
			}>
		>
	>;
	outfits: readonly OutfitId[];
	hats: readonly HatId[];
	props: readonly PropId[];
	hair: readonly HairId[];
	beards: readonly BeardId[];
	accessories: readonly AccessoryId[];
	palettes: Readonly<Record<PaletteName, CharacterColors>>;
	skins: readonly Hex[];
	hairColors: readonly Hex[];
}> = deepFreeze({
	classes: CLASSES,
	outfits: OUTFIT_IDS,
	hats: HAT_IDS,
	props: PROP_IDS,
	hair: HAIR_IDS,
	beards: BEARD_IDS,
	accessories: ACCESSORY_IDS,
	palettes: PALETTES,
	skins: SKINS,
	hairColors: HAIR_COLORS,
});

export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
