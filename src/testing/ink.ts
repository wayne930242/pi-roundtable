import { createCanvas, loadImage } from "canvas";

/** A decoded picture, to ask where it has drawing on it. */
export interface Ink {
	width: number;
	height: number;
	/** Whether the pixel at (x, y) differs from the one at the corner (0, 0), the ground. */
	marked(x: number, y: number): boolean;
	/** The pixel's red, green, blue, and alpha as one string, to compare two pictures. */
	pixel(x: number, y: number): string;
}

export async function inkOf(png: Uint8Array): Promise<Ink> {
	const image = await loadImage(Buffer.from(png));
	const canvas = createCanvas(image.width, image.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(image, 0, 0);
	const { data } = ctx.getImageData(0, 0, image.width, image.height);
	const at = (x: number, y: number) => (y * image.width + x) * 4;
	const same = (a: number, b: number) =>
		[0, 1, 2, 3].every((k) => data[a + k] === data[b + k]);
	return {
		width: image.width,
		height: image.height,
		marked: (x, y) => !same(at(x, y), 0),
		pixel: (x, y) => data.slice(at(x, y), at(x, y) + 4).join(","),
	};
}

/** How many pixels differ from the ground inside the rectangle. */
export function countInk(
	ink: Ink,
	x0 = 0,
	y0 = 0,
	x1 = ink.width,
	y1 = ink.height,
): number {
	let count = 0;
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) if (ink.marked(x, y)) count++;
	return count;
}

/** How many pixels in the outermost `margin` px of the picture differ from the ground. */
export function borderInk(ink: Ink, margin: number): number {
	return (
		countInk(ink, 0, 0, ink.width, margin) +
		countInk(ink, 0, ink.height - margin, ink.width, ink.height) +
		countInk(ink, 0, margin, margin, ink.height - margin) +
		countInk(ink, ink.width - margin, margin, ink.width, ink.height - margin)
	);
}
