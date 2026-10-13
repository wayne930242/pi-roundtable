import { createCanvas, loadImage } from "canvas";
import { assertImagePixelBudget } from "./image-budget.ts";
import { ImagePreparationError } from "./image-preparation-error.ts";

/** The longest side a picture may declare before `squarePng` refuses to decode it. */
export const SQUARE_PNG_MAX_SIDE = 4096;
/** The side `squarePng` scales to when it is not told one. */
const DEFAULT_SIDE = 512;
/** Below this side `squarePng` gives up fitting `maxBytes`. */
const SMALLEST_SIDE = 16;
/** Frames of an animation add up, so the whole stays within the budget `prepareImageBytes` allows. */
const DECODED_PIXEL_BUDGET = 8000 * 8000;

export interface SquarePngOptions {
	/** The most pixels per side of the result; default 512. A smaller picture is not enlarged. */
	size?: number;
	/** The most bytes of the result; the side steps down by a quarter until it fits. Default none. */
	maxBytes?: number;
	/**
	 * The longest side the picture may declare before it is refused, default 4096
	 * (`SQUARE_PNG_MAX_SIDE`). A picture within the 64 MP decoded-pixel budget but over it, such as a
	 * camera photo, is admitted by a larger value.
	 */
	maxSide?: number;
}

const wholeNumber = (name: string, value: number, max: number) => {
	if (!Number.isInteger(value) || value < 1 || value > max)
		throw new RangeError(
			`squarePng: ${name} must be a whole number from 1 to ${max}`,
		);
};

/**
 * A centered square crop of a PNG, JPEG or GIF, scaled down to at most `size` pixels per
 * side, as PNG. The header is read before anything is decoded: a declared width or height over
 * 4096 (`SQUARE_PNG_MAX_SIDE`, or `maxSide`) rejects with `ImagePreparationError` (`pixel-limit`),
 * and bytes of none of the three types (WebP included) with `invalid-image`, as does a picture
 * that cannot be decoded. With `maxBytes` the side steps down (by a quarter
 * each time) until the PNG is no larger; a picture that does not fit even at 16 pixels throws a
 * `RangeError`.
 */
export async function squarePng(
	bytes: Uint8Array,
	options: SquarePngOptions = {},
): Promise<Buffer> {
	const side = options.size ?? DEFAULT_SIDE;
	wholeNumber("size", side, SQUARE_PNG_MAX_SIDE);
	if (options.maxBytes !== undefined)
		wholeNumber("maxBytes", options.maxBytes, Number.MAX_SAFE_INTEGER);
	if (options.maxSide !== undefined)
		wholeNumber("maxSide", options.maxSide, Number.MAX_SAFE_INTEGER);
	const source = Buffer.from(bytes);
	// The canvas has no WebP decoder, so a WebP is refused here rather than failing in the decode.
	if (
		source.toString("ascii", 0, 4) === "RIFF" &&
		source.toString("ascii", 8, 12) === "WEBP"
	)
		throw new ImagePreparationError("invalid-image");
	assertImagePixelBudget(
		source,
		DECODED_PIXEL_BUDGET,
		options.maxSide ?? SQUARE_PNG_MAX_SIDE,
	);
	const image = await loadImage(source).catch(() => {
		throw new ImagePreparationError("invalid-image");
	});
	const crop = Math.min(image.width, image.height);
	let size = Math.min(side, crop);
	for (;;) {
		const canvas = createCanvas(size, size);
		canvas
			.getContext("2d")
			.drawImage(
				image,
				(image.width - crop) / 2,
				(image.height - crop) / 2,
				crop,
				crop,
				0,
				0,
				size,
				size,
			);
		const png = canvas.toBuffer("image/png");
		if (options.maxBytes === undefined || png.byteLength <= options.maxBytes)
			return png;
		size = Math.floor(size * 0.75);
		if (size < SMALLEST_SIDE)
			throw new RangeError(
				`squarePng: the picture does not fit ${options.maxBytes} bytes even at ${SMALLEST_SIDE} pixels`,
			);
	}
}
