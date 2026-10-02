import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadDecks } from "../src/cards/deck.ts";
import { drawCards } from "../src/cards/draw.ts";
import { seededRandom } from "../src/random.ts";

const decks = loadDecks(join(import.meta.dir, "decks"));

test("the example manifests are valid decks", () => {
	expect(decks.map((deck) => [deck.id, deck.cards.length])).toEqual([
		["playing-cards", 54],
		["tarot", 78],
	]);
});

test("every card of an example deck can be drawn", () => {
	for (const deck of decks) {
		const cards = drawCards({
			deck,
			count: deck.cards.length,
			group: undefined,
			exclude: undefined,
			allowReversed: undefined,
			random: seededRandom(1),
		});
		expect(new Set(cards.map((card) => card.id)).size).toBe(deck.cards.length);
	}
});
