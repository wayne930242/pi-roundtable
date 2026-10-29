import type { Hall } from "./hall";
import { ellipsize } from "./label";

/**
 * The lettering of a podium's nameplate. The name goes through the canvas' own text drawing with a
 * font stack that carries Chinese, Japanese and Korean, so a zh-TW name is drawn as the page shows it
 * (the old 3D labels were drawn with a Latin-only face and printed boxes). The name is never
 * altered: it is shrunk to fit and, past the smallest readable size, cut with an ellipsis.
 */
export const PLATE_FONT_STACK =
	'system-ui, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';

/** The part of a canvas context the plate needs, so a test can stand in for it. */
export interface PlateContext {
	font: string;
	fillStyle: string | CanvasGradient | CanvasPattern;
	strokeStyle: string | CanvasGradient | CanvasPattern;
	lineWidth: number;
	textAlign: CanvasTextAlign;
	textBaseline: CanvasTextBaseline;
	measureText(text: string): { width: number };
	fillText(text: string, x: number, y: number, maxWidth?: number): void;
	strokeText?(text: string, x: number, y: number, maxWidth?: number): void;
	fillRect(x: number, y: number, w: number, h: number): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	closePath(): void;
	arc(x: number, y: number, r: number, a: number, b: number): void;
	fill(): void;
	stroke(): void;
	createLinearGradient?(
		x0: number,
		y0: number,
		x1: number,
		y1: number,
	): CanvasGradient;
}

export interface PlateText {
	/** What was drawn: the name, or the name cut with an ellipsis when even the smallest size did not hold it. */
	text: string;
	/** The font size it was drawn at, in canvas px. */
	px: number;
	font: string;
}

const fontOf = (px: number) => `700 ${px}px ${PLATE_FONT_STACK}`;

/** The size a name is drawn at: as large as the room allows, no smaller than `floor` of the plate's height. */
export function fitPlateText(
	g: Pick<PlateContext, "measureText" | "font">,
	name: string,
	width: number,
	height: number,
): PlateText {
	const room = width * 0.86;
	const top = Math.round(height * 0.56);
	const floor = Math.round(height * 0.36);
	const widthAt = (text: string, px: number) => {
		g.font = fontOf(px);
		return g.measureText(text).width;
	};
	for (let px = top; px >= floor; px -= 2)
		if (widthAt(name, px) <= room) return { text: name, px, font: fontOf(px) };
	const text = ellipsize(
		name,
		(candidate) => widthAt(candidate, floor) <= room,
	);
	return { text, px: floor, font: fontOf(floor) };
}

/** A gold nameplate with the name in dark lettering, on a canvas of `width` × `height`. */
export function drawPlate(
	g: PlateContext,
	name: string,
	width: number,
	height: number,
	hall: Pick<Hall, "gold" | "goldDark" | "plateInk" | "ink">,
): PlateText {
	const inset = Math.max(3, height * 0.07);
	g.fillStyle = hall.ink;
	g.fillRect(0, 0, width, height);
	const face = g.createLinearGradient?.(0, 0, 0, height);
	if (face) {
		face.addColorStop(0, hall.gold);
		face.addColorStop(0.55, hall.gold);
		face.addColorStop(1, hall.goldDark);
		g.fillStyle = face;
	} else g.fillStyle = hall.gold;
	g.fillRect(inset, inset, width - inset * 2, height - inset * 2);
	g.strokeStyle = hall.goldDark;
	g.lineWidth = Math.max(1, height * 0.03);
	g.beginPath();
	g.moveTo(inset * 2, inset * 2);
	g.lineTo(width - inset * 2, inset * 2);
	g.lineTo(width - inset * 2, height - inset * 2);
	g.lineTo(inset * 2, height - inset * 2);
	g.closePath();
	g.stroke();
	g.fillStyle = hall.goldDark;
	for (const x of [inset * 3.4, width - inset * 3.4]) {
		g.beginPath();
		g.arc(x, height / 2, Math.max(1.4, height * 0.04), 0, Math.PI * 2);
		g.fill();
	}
	const text = fitPlateText(g, name, width - inset * 4, height);
	g.font = text.font;
	g.fillStyle = hall.plateInk;
	g.textAlign = "center";
	g.textBaseline = "middle";
	g.fillText(text.text, width / 2, height / 2 + height * 0.03);
	return text;
}
