import { PluginError } from "pi-roundtable";

export type DrawingToolName =
	| "relationship_map"
	| "magic_circle_generate"
	| "sigil_generate"
	| "sacred_geometry_generate"
	| "draw_cards";

/** Trusted wording of one drawing tool, as the model reads it; unset fields keep the defaults. */
export interface DrawingToolText {
	description?: string;
	/**
	 * Argument descriptions by argument path: the argument's name, or for one inside an object
	 * argument its names joined by dots, with arrays passed through (`"nodes.id"`, `"spread.label"`).
	 */
	parameters?: Record<string, string>;
}

const BACKGROUND = "Default dark.";

/**
 * The wording of each drawing tool as the package ships it: the description, and the argument
 * descriptions by argument path (an argument absent here has none). A host words only what must
 * differ through `toolText`, composing on these where it adds to them, and compares against them
 * to see what a new package version changed.
 *
 * `draw_cards` lists the host's decks after its description when the host sets none.
 */
export const DEFAULT_DRAWING_TOOL_TEXT: Readonly<
	Record<DrawingToolName, Required<DrawingToolText>>
> = {
	relationship_map: {
		description:
			"Draw a hand-drawn relationship map of characters (pc, npc) and factions, with typed relationships between them, and attach it to your reply as an image.",
		parameters: {
			"nodes.id": "Character or faction name.",
			"nodes.label": "A sub-label such as a role.",
			"edges.from": "The id of a node.",
			"edges.to": "The id of another node.",
			"edges.type":
				"romantic: arrow; entanglement: dashed arrow; bond: plain line; faction: dashed arrow; hostile: arrows both ways.",
		},
	},
	magic_circle_generate: {
		description:
			"Draw a magic circle: a pentagram, hexagram, or Tree of Life, with optional elemental symbols at the quarters and text around the rim, and attach it to your reply as an image.",
		parameters: {
			type: "custom draws a pentagram.",
			style: "Line weight.",
			elements: "Placed north, east, south, west in this order.",
			text: "Written around the rim.",
			size: "512, 1024, or 2048 px; default medium.",
			background: BACKGROUND,
		},
	},
	sigil_generate: {
		description:
			"Draw a sigil from an intention, by the chaos (letter elimination), rose cross, planetary, or geometric method, and attach it to your reply as an image.",
		parameters: { background: BACKGROUND },
	},
	sacred_geometry_generate: {
		description:
			"Draw sacred geometry: the Flower of Life, Metatron's Cube, a simplified Sri Yantra (nested triangles around a point, in a circle), or the Vesica Piscis, and attach it to your reply as an image. More layers add rings of circles, nested shapes, or, for Metatron's Cube, the outer ring (two or more layers).",
		parameters: {
			layers: "Default 3.",
			rotation: "Degrees.",
			colors: "CSS colors cycled per layer.",
			background: BACKGROUND,
		},
	},
	draw_cards: {
		description:
			"Draw cards from a full, freshly shuffled deck and attach a picture of the spread to your reply. Each draw is independent; pass exclude to leave cards out. Read the returned cards, not your own guess.",
		parameters: {
			deck: "The deck to draw from.",
			group:
				"Draw only from the cards of this group of the deck, when the deck has groups.",
			exclude: "Card ids to leave out, as the deck lists them.",
			allow_reversed:
				"Whether cards may come up reversed; the deck's own default when omitted.",
			spread: "One position per card for a named spread; omit for plain rows.",
			"spread.label": "What the position means, such as Past.",
			question: "The question, shown on the picture.",
		},
	},
};

/** One tool's resolved wording; the tool asks for each argument it describes. */
export interface ToolWording {
	/** The host's description, or undefined for the package's default. */
	readonly custom: string | undefined;
	readonly description: string;
	/** The `{ description }` of an argument, or nothing when it has none. */
	about(path: string): { description?: string };
	/** Fails when the host worded an argument the tool never asked for, such as a misspelled name. */
	check(): void;
}

export function toolWording(
	tool: DrawingToolName,
	text: DrawingToolText | undefined,
): ToolWording {
	const defaults = DEFAULT_DRAWING_TOOL_TEXT[tool];
	const asked = new Set<string>();
	return {
		custom: text?.description,
		description: text?.description ?? defaults.description,
		about: (path) => {
			asked.add(path);
			const description = text?.parameters?.[path] ?? defaults.parameters[path];
			return description ? { description } : {};
		},
		check: () => {
			for (const path of Object.keys(text?.parameters ?? {}))
				if (!asked.has(path))
					throw new PluginError(
						`plugin drawing: toolText.${tool} has no argument "${path}".`,
					);
		},
	};
}

/** Fails at setup on a tool name the plugin does not have. */
export function checkToolNames(
	text: Partial<Record<string, DrawingToolText>>,
): void {
	for (const name of Object.keys(text))
		if (!(name in DEFAULT_DRAWING_TOOL_TEXT))
			throw new PluginError(`plugin drawing: toolText has no tool "${name}".`);
}
