import { canvas } from "./decals";

/**
 * A seat's picture as a standee board: the character cut out along its outline with a thin light edge
 * (the white sticker rim of the concept art) and a dark line outside it. The picture is the
 * character kit's waist-up figure without its frame; the board's edge is drawn here, on the canvas,
 * because a frame would be a round badge and the standee is a cut-out.
 */

/** The rim's width as a fraction of the picture's width. */
const RIM = 0.034;
const LINE = 0.012;

const svgImage = (svg: string): Promise<HTMLImageElement> => {
	const img = new Image();
	img.decoding = "async";
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	return img.decode().then(() => img);
};

/** The picture's silhouette in one colour. */
function silhouette(
	img: HTMLImageElement,
	w: number,
	h: number,
	color: string,
): HTMLCanvasElement {
	const [c, g] = canvas(w, h);
	g.drawImage(img, 0, 0, w, h);
	g.globalCompositeOperation = "source-in";
	g.fillStyle = color;
	g.fillRect(0, 0, w, h);
	return c;
}

/** Offsets round a circle of `radius`, enough of them that the edge has no gaps at the sizes used. */
export function ringOffsets(
	radius: number,
	steps = 24,
): Array<[number, number]> {
	return Array.from({ length: steps }, (_, i) => {
		const a = (Math.PI * 2 * i) / steps;
		return [Math.cos(a) * radius, Math.sin(a) * radius];
	});
}

export interface Sticker {
	canvas: HTMLCanvasElement;
	/** The canvas' size relative to the picture, to size the board: pad on every side as a fraction of the picture. */
	pad: number;
}

/**
 * Draws the board for a figure: `px` wide for the picture, plus the rim's room on every side. The
 * result has a transparent ground, so the board is cut by its alpha.
 */
export async function stickerCanvas(
	svg: string,
	px: number,
	rim: string,
	ink: string,
): Promise<Sticker> {
	const img = await svgImage(svg);
	const ratio =
		(img.naturalHeight || img.height || px) /
		(img.naturalWidth || img.width || px);
	const w = Math.round(px);
	const h = Math.round(px * ratio);
	const edge = Math.ceil(px * (RIM + LINE)) + 2;
	const [out, g] = canvas(w + edge * 2, h + edge * 2);
	const dark = silhouette(img, w, h, ink);
	const light = silhouette(img, w, h, rim);
	for (const [dx, dy] of ringOffsets(px * (RIM + LINE)))
		g.drawImage(dark, edge + dx, edge + dy);
	for (const [dx, dy] of ringOffsets(px * RIM))
		g.drawImage(light, edge + dx, edge + dy);
	g.drawImage(img, edge, edge, w, h);
	return { canvas: out, pad: edge / w };
}
