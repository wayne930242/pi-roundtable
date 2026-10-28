import { createCanvas, loadImage } from "canvas";
import {
	type CharacterSpec,
	type ComposeOptions,
	composeSvg,
	STATE_EXPRESSION,
} from "../../characters/index.ts";

const PNG_SIDE = 512;

/** What a Discord avatar shows: the idle face on the modern light disc. */
const AVATAR_OPTIONS: ComposeOptions = {
	look: "modern-light",
	frame: "disc",
	expr: STATE_EXPRESSION.idle,
	state: "idle",
	still: true,
};

/**
 * A character as a PNG: the composer's SVG, rasterized by canvas (librsvg). The SVG is composer
 * output only, never text from a user or an agent. Each picture on a page needs its own `uid`,
 * so this passes one explicitly.
 */
export async function characterPng(
	spec: CharacterSpec,
	options: ComposeOptions = {},
): Promise<Uint8Array> {
	const size = options.size ?? PNG_SIDE;
	const svg = composeSvg(spec, {
		...AVATAR_OPTIONS,
		uid: "png",
		...options,
		size,
	});
	const image = await loadImage(Buffer.from(svg));
	const canvas = createCanvas(size, size);
	canvas.getContext("2d").drawImage(image, 0, 0, size, size);
	return canvas.toBuffer("image/png");
}
