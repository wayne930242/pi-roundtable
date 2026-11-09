import type {
	CharacterColors,
	CharacterSpec,
	Hex,
	PaletteName,
} from "./spec.ts";

/** Heraldic palettes: the field (also the agent accent), a secondary tincture and the metal trim. */
export const PALETTES: Record<PaletteName, CharacterColors> = {
	azure: { primary: "#3b6fd8", secondary: "#eef2ff", trim: "#f0c04a" },
	gules: { primary: "#d8473d", secondary: "#fff1e4", trim: "#f0c04a" },
	vert: { primary: "#2f9e6b", secondary: "#eefbea", trim: "#f0c04a" },
	purpure: { primary: "#7d52cc", secondary: "#f1e9ff", trim: "#f0c04a" },
	amber: { primary: "#e2a02a", secondary: "#fff6dc", trim: "#d5dbe8" },
	sable: { primary: "#454a5c", secondary: "#e9ecf4", trim: "#f0c04a" },
	teal: { primary: "#1f9aa6", secondary: "#e6fbfa", trim: "#f0c04a" },
	rose: { primary: "#d6507f", secondary: "#ffeef3", trim: "#d5dbe8" },
};

/** Skin tones, light to dark. */
export const SKINS: readonly Hex[] = [
	"#f7d6b8",
	"#eab98c",
	"#d4a070",
	"#b9784c",
	"#8e5b3c",
	"#5c3a26",
];

/** Hair swatches; a spec may carry any other hex. */
export const HAIR_COLORS: readonly Hex[] = [
	"#2b2233",
	"#6a4a33",
	"#b0562f",
	"#e0b45a",
	"#aeb4c3",
	"#f1f3fa",
];

export type ClassPreset = Omit<CharacterSpec, "v" | "class">;

export function preset(
	fields: Omit<ClassPreset, "colors" | "palette"> & { palette: PaletteName },
): ClassPreset {
	const { palette, ...rest } = fields;
	return { ...rest, colors: { ...PALETTES[palette] }, palette };
}

export interface ClassEntry {
	label: string;
	/** The agent jobs the class suits. */
	jobs: string;
	/** English and zh-TW words that suggest the class from an agent's name and prompt. */
	keywords: readonly string[];
	preset: ClassPreset;
}
