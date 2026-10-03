import {
	definePlugin,
	PluginError,
	type Tier,
	type ToolTurn,
} from "pi-roundtable";
import { type Deck, DeckError, loadDecks } from "./cards/deck.ts";
import type { Random } from "./random.ts";
import { drawCardsTool } from "./tools/draw-cards-tool.ts";
import type { ImageToolEnv } from "./tools/image-tool.ts";
import {
	magicCircleTool,
	sacredGeometryTool,
	sigilTool,
} from "./tools/magic-tools.ts";
import { relationshipMapTool } from "./tools/relationship-map-tool.ts";

export interface CardPresentation {
	/** Trusted host presentation; never part of the model's tool arguments. */
	heading?: (
		draw: { deck: Deck; count: number; question?: string },
		turn: ToolTurn,
	) => { title: string; subtitle: string };
	/** Appended to reversed card names on the picture; default " (reversed)". */
	reversedSuffix?: string;
	/**
	 * The text the model reads back after a draw; `{file}` stands for the attached file's name.
	 * Default: the deck id, then one numbered line per card with its position label and id.
	 */
	result?: (draw: {
		deck: Deck;
		cards: { id: string; name: string; reversed: boolean }[];
		positions: { row: number; col: number; label?: string | undefined }[];
	}) => string;
}

/** Longest map text a host accepts, in characters; the defaults suit a picture that stays readable. */
export interface RelationshipMapLimits {
	title?: number;
	/** Node ids, node labels and edge labels. */
	text?: number;
}

export interface DrawingOptions {
	/**
	 * A directory with one subdirectory for each deck, each holding a `deck.json` and the card
	 * faces it names. Without it the plugin has no `draw_cards` tool. The package ships no card
	 * faces; see the README for the layout.
	 */
	deckDir?: string;
	/** The random source of the map layouts and the card draws; `Math.random` by default. A seeded source draws the same picture every time. */
	random?: Random;
	/** The lowest tier that may use the tools; default `member`. */
	minTier?: Tier;
	/** Operator-local captions and reversal wording; default package presentation. */
	cardPresentation?: CardPresentation;
	/** Longer map text than the defaults, for a host whose callers already draw longer labels. */
	mapLimits?: RelationshipMapLimits;
}

function readDecks(deckDir: string): Deck[] {
	try {
		return loadDecks(deckDir);
	} catch (error) {
		if (error instanceof DeckError)
			throw new PluginError(`plugin drawing: ${error.message}`);
		throw error;
	}
}

/**
 * Tools that draw images locally with node-canvas and attach them to the agent's reply: relationship
 * maps, magic circles, sigils, sacred geometry, and, with a `deckDir`, card draws.
 */
export function drawing(options: DrawingOptions = {}) {
	const random = options.random ?? Math.random;
	return definePlugin({
		name: "drawing",
		setup: () => {
			// Read at setup, so a wrong deck directory stops the start with a message that names this plugin.
			const decks = options.deckDir ? readDecks(options.deckDir) : [];
			const env: ImageToolEnv = {
				minTier: options.minTier ?? "member",
			};
			return {
				tools: [
					relationshipMapTool(env, random, options.mapLimits),
					magicCircleTool(env),
					sigilTool(env),
					sacredGeometryTool(env),
					...(decks.length > 0
						? [drawCardsTool(decks, env, random, options.cardPresentation)]
						: []),
				],
			};
		},
	});
}
