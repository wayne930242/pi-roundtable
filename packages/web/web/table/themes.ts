import type { Scheme, ThemeName } from "./types";

export interface Palette {
	bg: string;
	floor: string;
	floorTex: "stone" | "plain";
	table: string;
	rim: string;
	pedestal: string;
	stool: string;
	inlay: string;
	inlayTex: "rune" | "ring";
	rug: string;
	rugEdge: string;
	hemiSky: string;
	hemiGround: string;
	hemiI: number;
	keyColor: string;
	keyI: number;
	pointColor: string;
	pointI: number;
	/** candle flames + candelabra (camelot) vs. soft pucks (modern) */
	candles: boolean;
	flame: string;
	flameI: number;
	shadow: number;
	labelBg: string;
	labelFg: string;
	labelAccent: string;
	/** additive glows vanish on light backdrops, so light schemes blend normally */
	glowBlend: "add" | "normal";
	glowGain: number;
	/** CSS colours for the SVG fallback */
	css: {
		bg: string;
		table: string;
		rim: string;
		floor: string;
		text: string;
		plate: string;
	};
}

const P: Record<ThemeName, Record<Scheme, Palette>> = {
	modern: {
		light: {
			bg: "#e8ebef",
			floor: "#d6dbe2",
			floorTex: "plain",
			table: "#e6c79a",
			rim: "#bf986a",
			pedestal: "#a3a9b2",
			stool: "#8e98a8",
			inlay: "#ffffff",
			inlayTex: "ring",
			rug: "#f8f9fb",
			rugEdge: "#b7bfca",
			hemiSky: "#ffffff",
			hemiGround: "#c7ccd4",
			hemiI: 1.9,
			keyColor: "#fff3e2",
			keyI: 1.5,
			pointColor: "#ffffff",
			pointI: 0,
			candles: false,
			flame: "#ffd9a0",
			flameI: 0.5,
			shadow: 0.3,
			labelBg: "#ffffff",
			labelFg: "#1f2430",
			labelAccent: "#1f2430",
			glowBlend: "normal",
			glowGain: 0.9,
			css: {
				bg: "#e8ebef",
				table: "#e6c79a",
				rim: "#bf986a",
				floor: "#d6dbe2",
				text: "#1f2430",
				plate: "#ffffff",
			},
		},
		dark: {
			bg: "#0f1218",
			floor: "#1a1f29",
			floorTex: "plain",
			table: "#a7794f",
			rim: "#6e4d33",
			pedestal: "#3a404c",
			stool: "#5d6a82",
			inlay: "#e9d3b4",
			inlayTex: "ring",
			rug: "#262e3b",
			rugEdge: "#161b24",
			hemiSky: "#9bb0d6",
			hemiGround: "#222633",
			hemiI: 1.5,
			keyColor: "#d7e4ff",
			keyI: 1.1,
			pointColor: "#ffffff",
			pointI: 0,
			candles: false,
			flame: "#ffcf8a",
			flameI: 0.7,
			shadow: 0.55,
			labelBg: "#1c212b",
			labelFg: "#f2f4f8",
			labelAccent: "#f2f4f8",
			glowBlend: "add",
			glowGain: 1,
			css: {
				bg: "#0f1218",
				table: "#a7794f",
				rim: "#6e4d33",
				floor: "#1a1f29",
				text: "#f2f4f8",
				plate: "#1c212b",
			},
		},
	},
	camelot: {
		light: {
			bg: "#e4d4ab",
			floor: "#b6ad9a",
			floorTex: "stone",
			table: "#b57a3f",
			rim: "#c9a227",
			pedestal: "#715f48",
			stool: "#a8744a",
			inlay: "#e8c24a",
			inlayTex: "rune",
			rug: "#8d4a3d",
			rugEdge: "#c9a227",
			hemiSky: "#fff1d2",
			hemiGround: "#a89168",
			hemiI: 1.8,
			keyColor: "#ffe0ac",
			keyI: 1.35,
			pointColor: "#ffb35c",
			pointI: 10,
			candles: true,
			flame: "#ff9d2e",
			flameI: 0.8,
			shadow: 0.38,
			labelBg: "#f6ebcd",
			labelFg: "#3a2a14",
			labelAccent: "#b8901c",
			glowBlend: "normal",
			glowGain: 0.95,
			css: {
				bg: "#e4d4ab",
				table: "#b57a3f",
				rim: "#c9a227",
				floor: "#b6ad9a",
				text: "#3a2a14",
				plate: "#f6ebcd",
			},
		},
		dark: {
			bg: "#070c24",
			floor: "#222844",
			floorTex: "stone",
			table: "#7a4b2b",
			rim: "#d4af37",
			pedestal: "#2c2640",
			stool: "#9c6b3c",
			inlay: "#e0b94a",
			inlayTex: "rune",
			rug: "#3a1730",
			rugEdge: "#d4af37",
			hemiSky: "#5365b8",
			hemiGround: "#0f1330",
			hemiI: 1.15,
			keyColor: "#a8bcff",
			keyI: 0.7,
			pointColor: "#ffa04a",
			pointI: 26,
			candles: true,
			flame: "#ffa63d",
			flameI: 1,
			shadow: 0.6,
			labelBg: "#0f1638",
			labelFg: "#f6e6b4",
			labelAccent: "#d4af37",
			glowBlend: "add",
			glowGain: 1.05,
			css: {
				bg: "#070c24",
				table: "#7a4b2b",
				rim: "#d4af37",
				floor: "#222844",
				text: "#f6e6b4",
				plate: "#0f1638",
			},
		},
	},
};

export const palette = (t: ThemeName, s: Scheme): Palette => P[t][s];

/** state accent shared by the 3D scene and the SVG fallback */
export const STATE_COLOR = { done: "#58c878", error: "#ee4b4b" } as const;
