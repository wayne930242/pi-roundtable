import { definePlugin, PluginError, type Tier } from "pi-roundtable";
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
 * Tools that draw images locally with node-canvas and post them to the channel: relationship
 * maps, magic circles, sigils, sacred geometry, and, with a `deckDir`, card draws.
 */
export function drawing(options: DrawingOptions = {}) {
	const random = options.random ?? Math.random;
	return definePlugin({
		name: "drawing",
		setup: ({ surfaces }) => {
			// Read at setup, so a wrong deck directory stops the start with a message that names this plugin.
			const decks = options.deckDir ? readDecks(options.deckDir) : [];
			const env: ImageToolEnv = {
				minTier: options.minTier ?? "member",
				send: (channel, file) =>
					surfaces.sendReply(channel, { chunks: [], files: [file] }),
			};
			return {
				tools: [
					relationshipMapTool(env, random),
					magicCircleTool(env),
					sigilTool(env),
					sacredGeometryTool(env),
					...(decks.length > 0 ? [drawCardsTool(decks, env, random)] : []),
				],
			};
		},
	});
}
