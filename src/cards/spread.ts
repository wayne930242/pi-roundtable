import { type CanvasRenderingContext2D, createCanvas, loadImage } from "canvas";
import { DrawingError } from "../errors.ts";
import { ensureFont, font, PALETTE } from "../style.ts";
import { type Deck, MAX_ASPECT, MIN_ASPECT } from "./deck.ts";
import type { DrawnCard } from "./draw.ts";

export interface SpreadPosition {
	row: number;
	col: number;
	label: string;
}

/** The most rows or columns a spread of your own may use; the schema holds the model to it. */
export const MAX_GRID = 10;

const PADDING = 32;
const HEADING = 64;
const GAP = 20;
const LABEL = 26;
const NAME = 30;
const DEFAULT_ASPECT = 1.5;
/** The picture stays within what canvas can allocate. */
const MAX_SIDE = 16384;
const MAX_PIXELS = 40_000_000;

function cardWidth(count: number): number {
	if (count <= 5) return 200;
	if (count <= 21) return 150;
	return 110;
}

/** Without a custom spread, cards fill rows left to right: one row up to five, then wider rows. */
export function autoLayout(count: number): SpreadPosition[] {
	const cols = count <= 5 ? count : count <= 10 ? 5 : 7;
	return Array.from({ length: count }, (_, i) => ({
		row: Math.floor(i / cols),
		col: i % cols,
		label: "",
	}));
}

/** A spread needs one position for each card, none shared. */
export function checkSpread(
	positions: readonly SpreadPosition[],
	count: number,
): void {
	if (positions.length !== count)
		throw new DrawingError(
			`The spread has ${positions.length} positions for ${count} cards. Give one position for each card.`,
		);
	const cells = new Set<string>();
	for (const { row, col } of positions) {
		if (![row, col].every((n) => Number.isInteger(n) && n >= 0))
			throw new DrawingError(
				`Spread positions need a row and a column that are whole numbers from 0; got row ${row}, column ${col}.`,
			);
		const cell = `${row}:${col}`;
		if (cells.has(cell))
			throw new DrawingError(
				`Two cards share row ${row}, column ${col}. Give each card its own position.`,
			);
		cells.add(cell);
	}
}

function fitText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let cut = text;
	while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth)
		cut = cut.slice(0, -1);
	return `${cut}…`;
}

/** Breaks text into lines no wider than `maxWidth`, at spaces and, for a long word, anywhere. */
function wrapText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const next = line ? `${line} ${word}` : word;
		if (ctx.measureText(next).width <= maxWidth) {
			line = next;
			continue;
		}
		if (line) lines.push(line);
		line = "";
		for (const char of word) {
			if (line && ctx.measureText(line + char).width > maxWidth) {
				lines.push(line);
				line = "";
			}
			line += char;
		}
	}
	if (line) lines.push(line);
	return lines;
}

/**
 * Draws the cards on a dark ground, every face visible. A card without a face image is a tile
 * with its name. A reversed card is drawn upside down and marked "reversed" under its name.
 */
export async function renderSpread(
	deck: Deck,
	cards: readonly DrawnCard[],
	positions: readonly SpreadPosition[],
	heading: { title: string; subtitle: string },
): Promise<Uint8Array> {
	checkSpread(positions, cards.length);
	ensureFont();
	const faces = await Promise.all(
		cards.map(async (card) => {
			if (!card.face) return undefined;
			try {
				return await loadImage(card.face);
			} catch (error) {
				throw new DrawingError(
					`The face of card ${card.id} in deck ${deck.id} cannot be read as an image (${error instanceof Error ? error.message : String(error)}). Fix ${card.face}.`,
				);
			}
		}),
	);
	const firstFace = faces.find((face) => face !== undefined);
	const aspect =
		deck.aspect ??
		(firstFace ? firstFace.height / firstFace.width : DEFAULT_ASPECT);
	if (aspect < MIN_ASPECT || aspect > MAX_ASPECT)
		throw new DrawingError(
			`Deck ${deck.id} draws cards ${aspect.toFixed(2)} times as tall as wide; set aspect in its deck.json to a value from ${MIN_ASPECT} to ${MAX_ASPECT}.`,
		);
	const width = cardWidth(cards.length);
	const height = Math.round(width * aspect);
	const hasLabels = positions.some((p) => p.label);
	const cellW = width + GAP;
	const cellH = (hasLabels ? LABEL : 0) + height + NAME + GAP;
	const cols = Math.max(...positions.map((p) => p.col)) + 1;
	const rows = Math.max(...positions.map((p) => p.row)) + 1;
	const gridW = cols * cellW - GAP;
	const canvasW = Math.max(PADDING * 2 + gridW, 520);
	// A narrow spread is centred on the minimum width the heading needs.
	const left = (canvasW - gridW) / 2;
	const canvasH = PADDING * 2 + HEADING + rows * cellH - GAP;
	if (
		canvasW > MAX_SIDE ||
		canvasH > MAX_SIDE ||
		canvasW * canvasH > MAX_PIXELS
	)
		throw new DrawingError(
			`The spread would be ${canvasW} by ${canvasH} px, which is too large to draw. Draw fewer cards or use a smaller grid.`,
		);

	const canvas = createCanvas(canvasW, canvasH);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = PALETTE.background;
	ctx.fillRect(0, 0, canvasW, canvasH);

	ctx.textBaseline = "top";
	ctx.textAlign = "left";
	ctx.fillStyle = PALETTE.accentLight;
	ctx.font = font(20);
	ctx.fillText(
		fitText(ctx, heading.title, canvasW - PADDING * 2),
		PADDING,
		PADDING,
	);
	ctx.fillStyle = PALETTE.text;
	ctx.font = font(26);
	ctx.fillText(
		fitText(ctx, heading.subtitle, canvasW - PADDING * 2),
		PADDING,
		PADDING + 26,
	);

	const top = PADDING + HEADING;
	for (const [i, card] of cards.entries()) {
		const position = positions[i];
		if (!position) continue;
		const x = left + position.col * cellW;
		let y = top + position.row * cellH;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		if (hasLabels) {
			ctx.fillStyle = PALETTE.accentLight;
			ctx.font = font(16);
			ctx.fillText(fitText(ctx, position.label, width), x + width / 2, y);
			y += LABEL;
		}

		const face = faces[i];
		// A reversed card turns upside down whole, face or tile; its name stays upright below.
		ctx.save();
		if (card.reversed) {
			ctx.translate(x + width, y + height);
			ctx.rotate(Math.PI);
		} else {
			ctx.translate(x, y);
		}
		if (face) {
			ctx.drawImage(face, 0, 0, width, height);
		} else {
			ctx.fillStyle = PALETTE.surface;
			ctx.fillRect(0, 0, width, height);
			ctx.strokeStyle = PALETTE.accent;
			ctx.lineWidth = 2;
			ctx.strokeRect(1, 1, width - 2, height - 2);
			ctx.fillStyle = PALETTE.text;
			ctx.font = font(width < 150 ? 14 : 18);
			ctx.textBaseline = "middle";
			const lines = wrapText(ctx, card.name, width - 16).slice(0, 6);
			const lineHeight = width < 150 ? 18 : 24;
			const first = height / 2 - ((lines.length - 1) * lineHeight) / 2;
			lines.forEach((line, n) => {
				ctx.fillText(line, width / 2, first + n * lineHeight);
			});
		}
		ctx.restore();
		ctx.textBaseline = "top";

		ctx.fillStyle = card.reversed ? PALETTE.accentLight : PALETTE.text;
		ctx.font = font(width < 150 ? 12 : 15);
		const name = card.reversed ? `${card.name} (reversed)` : card.name;
		ctx.fillText(fitText(ctx, name, width), x + width / 2, y + height + 8);
	}
	return new Uint8Array(canvas.toBuffer("image/png"));
}
