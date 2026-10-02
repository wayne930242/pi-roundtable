import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DrawingError } from "../errors.ts";
import { countInk, inkOf } from "../testing/ink.ts";
import { writeTestDecks } from "../testing/test-deck.ts";
import { type Deck, loadDecks } from "./deck.ts";
import type { DrawnCard } from "./draw.ts";
import { autoLayout, renderSpread } from "./spread.ts";

let root = "";
let poker: Deck;
beforeAll(() => {
	root = writeTestDecks();
	poker = loadDecks(root).find((deck) => deck.id === "test-poker") as Deck;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const heading = { title: "Deck", subtitle: "Question" };

describe("renderSpread", () => {
	test("a reversed card with no face is turned upside down, its name under it stays upright", async () => {
		const card = poker.cards[0];
		if (!card) throw new Error("no card");
		const draw = (reversed: boolean): DrawnCard[] => [{ ...card, reversed }];
		const upright = await inkOf(
			await renderSpread(poker, draw(false), autoLayout(1), heading),
		);
		const turned = await inkOf(
			await renderSpread(poker, draw(true), autoLayout(1), heading),
		);
		// The tile is the same size and its text sits at the middle, but a half-turn moves the glyphs.
		const tile = { x0: 160, y0: 96, x1: 360, y1: 96 + 300 };
		const differs = (a: typeof upright, b: typeof turned) => {
			let count = 0;
			for (let y = tile.y0; y < tile.y1; y++)
				for (let x = tile.x0; x < tile.x1; x++)
					if (a.pixel(x, y) !== b.pixel(x, y)) count++;
			return count;
		};
		expect(differs(upright, turned)).toBeGreaterThan(50);
		expect(countInk(upright, tile.x0, tile.y0, tile.x1, tile.y1)).toBe(
			countInk(turned, tile.x0, tile.y0, tile.x1, tile.y1),
		);
	});

	test("a deck whose aspect canvas cannot draw is refused before anything is allocated", async () => {
		const tall: Deck = { ...poker, aspect: 4 };
		const cards = Array.from(
			{ length: 100 },
			(_, i): DrawnCard => ({
				id: `c${i}`,
				name: `Card ${i}`,
				reversed: false,
			}),
		);
		// A hundred cards four times as tall as wide fit; a column of them with a custom grid does not.
		const positions = cards.map((_, i) => ({ row: i, col: 0, label: "" }));
		await expect(
			renderSpread(tall, cards, positions, heading),
		).rejects.toBeInstanceOf(DrawingError);
	});
});
