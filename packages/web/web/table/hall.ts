import type { Scheme, ThemeName } from "./types";

/**
 * The council hall's colours. Dark is the night hall of the concept art (slate and navy stone, teal
 * runes, gold trim, torches); light is the same hall by day (warmer stone, sun through the window).
 * The geometry never changes with the palette. The look moves only the accents: the banners and the
 * metal of the trim.
 */
export interface Hall {
	/** The sky behind the scene, the fog and the letterbox. */
	bg: string;
	/** The outline of every shape: the characters' ink. */
	ink: string;
	stone: string;
	stoneShade: string;
	stoneJoint: string;
	floor: string;
	floorJoint: string;
	/** The glowing circle on the floor. */
	rune: string;
	runeGlow: number;
	wood: string;
	woodDark: string;
	woodLight: string;
	gold: string;
	goldDark: string;
	banner: string;
	bannerEdge: string;
	glass: string;
	glassLight: string;
	glassDark: string;
	/** The moon at night, the sun by day. */
	sky: string;
	/** Light shafts through the window. */
	beam: string;
	beamAlpha: number;
	flame: string;
	flameCore: string;
	/** Light and shade on the toon materials. */
	ambient: string;
	ambientI: number;
	key: string;
	keyI: number;
	/** The plate's lettering on the gold. */
	plateInk: string;
	/** The board's rim and the badge's face. */
	paper: string;
	/** The speaking podium's light. */
	spot: string;
	/** Night shows a moon and stars in the windows, day a sun. */
	night: boolean;
	/** Additive glows vanish on a light backdrop, so a light scheme blends them normally. */
	additive: boolean;
	/** The 2D fallback's surfaces. */
	css: { bg: string; floor: string; ring: string; text: string; plate: string };
}

const NIGHT: Hall = {
	bg: "#0a1130",
	ink: "#0b0f1e",
	stone: "#3c4a6d",
	stoneShade: "#2a3555",
	stoneJoint: "#1d2745",
	floor: "#2b3756",
	floorJoint: "#1b2442",
	rune: "#3fe6cb",
	runeGlow: 0.9,
	wood: "#5b3a22",
	woodDark: "#3a2314",
	woodLight: "#7d5231",
	gold: "#e3b24b",
	goldDark: "#9a6c1d",
	banner: "#1b5160",
	bannerEdge: "#e3b24b",
	glass: "#2e53a3",
	glassLight: "#5f86d6",
	glassDark: "#1b2f66",
	sky: "#f6f3da",
	beam: "#9fb9ff",
	beamAlpha: 0.2,
	flame: "#ffb23a",
	flameCore: "#fff0a8",
	ambient: "#6f86c9",
	ambientI: 1.55,
	key: "#aebfff",
	keyI: 1.4,
	plateInk: "#3a2410",
	paper: "#f4efe3",
	spot: "#ffe29a",
	night: true,
	additive: true,
	css: {
		bg: "#0a1130",
		floor: "#2b3756",
		ring: "#3fe6cb",
		text: "#f4efe3",
		plate: "#e3b24b",
	},
};

const DAY: Hall = {
	bg: "#e8dcc0",
	ink: "#2a2036",
	stone: "#b9ae9a",
	stoneShade: "#938873",
	stoneJoint: "#756b5a",
	floor: "#cfc2a6",
	floorJoint: "#a79a80",
	rune: "#1c9d8f",
	runeGlow: 0.75,
	wood: "#8c5a33",
	woodDark: "#5d3a20",
	woodLight: "#ab7443",
	gold: "#e0a92f",
	goldDark: "#936718",
	banner: "#2c7283",
	bannerEdge: "#e0a92f",
	glass: "#8dbbe6",
	glassLight: "#c4e0f6",
	glassDark: "#5d8dc2",
	sky: "#ffe9a6",
	beam: "#fff0b4",
	beamAlpha: 0.32,
	flame: "#ff9a2c",
	flameCore: "#ffe7a0",
	ambient: "#fff1d4",
	ambientI: 2.1,
	key: "#ffe3b0",
	keyI: 1.6,
	plateInk: "#3a2410",
	paper: "#fffaf0",
	spot: "#fff0b0",
	night: false,
	additive: false,
	css: {
		bg: "#e8dcc0",
		floor: "#cfc2a6",
		ring: "#1c9d8f",
		text: "#2a2036",
		plate: "#e0a92f",
	},
};

/** The look's accents laid over the hall: modern keeps the teal banners and bright brass, Camelot goes heraldic. */
const ACCENT: Record<
	ThemeName,
	Record<Scheme, Pick<Hall, "banner" | "bannerEdge" | "gold" | "goldDark">>
> = {
	modern: {
		dark: {
			banner: NIGHT.banner,
			bannerEdge: NIGHT.gold,
			gold: NIGHT.gold,
			goldDark: NIGHT.goldDark,
		},
		light: {
			banner: DAY.banner,
			bannerEdge: DAY.gold,
			gold: DAY.gold,
			goldDark: DAY.goldDark,
		},
	},
	camelot: {
		dark: {
			banner: "#6b1f3f",
			bannerEdge: "#f0c35a",
			gold: "#f0c35a",
			goldDark: "#a8791f",
		},
		light: {
			banner: "#9b2a45",
			bannerEdge: "#e6b436",
			gold: "#e6b436",
			goldDark: "#9a6b14",
		},
	},
};

export const hallOf = (theme: ThemeName, scheme: Scheme): Hall => ({
	...(scheme === "dark" ? NIGHT : DAY),
	...ACCENT[theme][scheme],
});
