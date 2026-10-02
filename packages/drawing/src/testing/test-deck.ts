import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "canvas";
import { ensureFont, font } from "../style.ts";

/** A generated card face: a coloured portrait with the card's number, as a PNG. */
export function facePng(
	label: string,
	hue: number,
	width = 140,
	height = 240,
): Buffer {
	ensureFont();
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = `hsl(${hue}, 45%, 35%)`;
	ctx.fillRect(0, 0, width, height);
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 4;
	ctx.strokeRect(6, 6, width - 12, height - 12);
	ctx.fillStyle = "#ffffff";
	ctx.font = font(48);
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(label, width / 2, height / 2);
	return canvas.toBuffer("image/png");
}

/**
 * Writes placeholder decks and returns their directory. `test-tarot` has generated faces and
 * two groups; `test-poker` has no faces and is upright by default; `test-large` has 100 cards
 * with no faces. Nothing here is a real deck.
 */
export function writeTestDecks(): string {
	const root = mkdtempSync(join(tmpdir(), "drawing-decks-"));

	const tarot = join(root, "test-tarot");
	mkdirSync(join(tarot, "faces"), { recursive: true });
	const cards = Array.from({ length: 10 }, (_, i) => {
		const major = i < 6;
		const id = major ? `major-${i}` : `minor-${i - 6}`;
		writeFileSync(
			join(tarot, "faces", `${id}.png`),
			facePng(String(i), i * 36),
		);
		return {
			id,
			name: major ? `Major Card ${i}` : `Minor Card ${i - 6}`,
			file: `faces/${id}.png`,
			group: major ? "major" : "minor",
		};
	});
	writeFileSync(
		join(tarot, "deck.json"),
		JSON.stringify({ name: "Test Tarot", cards }),
	);

	const poker = join(root, "test-poker");
	mkdirSync(poker);
	const suits = ["S", "H", "D", "C"];
	const pokerCards = suits.flatMap((suit) =>
		["A", "2", "3", "4", "5"].map((rank) => ({
			id: `${rank}${suit}`,
			name: `${rank} of ${suit}`,
		})),
	);
	writeFileSync(
		join(poker, "deck.json"),
		JSON.stringify({
			name: "Test Playing Cards",
			reversals: false,
			cards: pokerCards,
		}),
	);

	const large = join(root, "test-large");
	mkdirSync(large);
	writeFileSync(
		join(large, "deck.json"),
		JSON.stringify({
			name: "Test Large Deck",
			cards: Array.from({ length: 100 }, (_, i) => ({
				id: `c${i}`,
				name: `Card ${i}`,
			})),
		}),
	);
	return root;
}
