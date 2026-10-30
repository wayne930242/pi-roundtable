import { Type } from "typebox";
import {
	CATALOG,
	type CharacterInput,
	CLASS_IDS,
	type PaletteName,
} from "../../characters/index.ts";
import { optionalString } from "../runtime/text-tools.ts";
import { MAX_PROMPT_CHARS } from "./agent-rules.ts";

const PALETTE_NAMES = Object.keys(CATALOG.palettes) as PaletteName[];

// The parts of the agent tools' input that more than one tool takes.
export const NAME = Type.String({
	description:
		"An agent's name (lowercase, from agent_list), not its display name.",
});
export const DISPLAY = Type.String({
	minLength: 1,
	maxLength: 32,
	description: "The name shown on its messages; any language.",
});
export const PROMPT = Type.String({
	minLength: 1,
	maxLength: MAX_PROMPT_CHARS,
	description:
		"The agent's role prompt, in English: its job, sources, boundaries, and how it reports. Short and stated positively.",
});
const enumOf = (ids: readonly string[], description?: string) =>
	Type.String({ enum: [...ids], ...(description ? { description } : {}) });
export const CLASS = enumOf(
	CLASS_IDS,
	`The agent's character class, which sets its outfit, hat, and prop. ${CLASS_IDS.map((id) => `${id}: ${CATALOG.classes[id].jobs}`).join("; ")}.`,
);
export const COLOR = enumOf(
	PALETTE_NAMES,
	"The agent's color palette. Pick one unlike the other agents' (agent_get shows each look).",
);
export const PARTS = Type.Object(
	{
		outfit: Type.Optional(enumOf(CATALOG.outfits)),
		hat: Type.Optional(enumOf(CATALOG.hats)),
		prop: Type.Optional(enumOf(CATALOG.props)),
		hair: Type.Optional(enumOf(CATALOG.hair)),
		beard: Type.Optional(enumOf([...CATALOG.beards, "none"])),
		accessory: Type.Optional(enumOf([...CATALOG.accessories, "none"])),
		build: Type.Optional(enumOf(["slim", "regular", "stout"])),
		skin: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
		hair_color: Type.Optional(
			Type.String({
				pattern: "^#[0-9a-fA-F]{6}$",
				description: "A hex color such as #3b2a1a.",
			}),
		),
	},
	{ description: "Single parts to change; any left out stay as they are." },
);
const PART_FIELDS = {
	outfit: "outfit",
	hat: "hat",
	prop: "prop",
	hair: "hair",
	beard: "beard",
	accessory: "accessory",
	build: "build",
	skin: "skin",
	hair_color: "hairColor",
} as const;

/** The look a tool call names: class, color as palette, and parts; nothing it leaves out. */
export function lookOf(input: Record<string, unknown>): CharacterInput {
	const look: Record<string, unknown> = {};
	const klass = optionalString(input, "class");
	const color = optionalString(input, "color");
	if (klass) look.class = klass;
	if (color) look.palette = color;
	const parts = input.parts;
	if (parts !== null && typeof parts === "object")
		for (const [key, field] of Object.entries(PART_FIELDS)) {
			const value = (parts as Record<string, unknown>)[key];
			if (value !== undefined) look[field] = value;
		}
	return look as CharacterInput;
}
