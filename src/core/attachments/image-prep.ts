import { createCanvas, loadImage } from "canvas";
import {
	MAX_TURN_IMAGES,
	type ModelImage,
	type StoredAttachment,
} from "../domain/attachment.ts";
import { MAX_ATTACHMENT_BYTES } from "./attachment-fetcher.ts";
import { assertImagePixelBudget } from "./image-budget.ts";
import { ImagePreparationError } from "./image-preparation-error.ts";

/** Images the model accepts as images; other files stay files. */
const IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
export const MAX_IMAGES_PER_TURN = MAX_TURN_IMAGES;
/** Base64 grows by a third, so 3.75 MB stays under Claude's 5 MB per image. */
const MAX_RAW_BYTES = 3.75 * 1024 * 1024;
const MAX_SIDE = 8000;
const DOWNSCALED_SIDE = 2000;

export function isModelImage(
	file: Pick<StoredAttachment, "contentType">,
): boolean {
	return IMAGE_TYPES.has(
		file.contentType.split(";")[0]?.trim().toLowerCase() ?? "",
	);
}

/**
 * The type the bytes themselves say they are (PNG, JPEG, GIF or WebP), whatever was declared for
 * them; undefined for anything else.
 */
export function sniffImageType(data: Uint8Array): string | undefined {
	const at = (offset: number, ...bytes: number[]) =>
		bytes.every((byte, index) => data[offset + index] === byte);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (
		at(0, 0x47, 0x49, 0x46, 0x38) &&
		(at(4, 0x37) || at(4, 0x39)) &&
		at(5, 0x61)
	)
		return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
		return "image/webp";
	return undefined;
}

/**
 * Returns the image as the model accepts it. An image over the size or side limit is
 * re-encoded as JPEG with its long side at 2,000 px instead of being dropped.
 */
export async function prepareImage(
	file: Pick<StoredAttachment, "path" | "contentType">,
): Promise<ModelImage> {
	const reader = Bun.file(file.path).stream().getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_ATTACHMENT_BYTES)
				throw new ImagePreparationError("byte-limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return prepareImageBytes(Buffer.concat(chunks, size), file.contentType);
}

/** Prepare bounded raster bytes without reopening a guest-writable filesystem path.
 * Headers and all GIF/WebP frames must fit 64 MP; encoded bytes must fit 25 MiB. The type of the
 * result is the one the bytes show (PNG, JPEG, GIF or WebP), not the declared `contentType`, which
 * may be a file name's guess; bytes of none of them are `invalid-image`. */
export async function prepareImageBytes(
	data: Uint8Array,
	_contentType: string,
): Promise<ModelImage> {
	if (data.byteLength > MAX_ATTACHMENT_BYTES)
		throw new ImagePreparationError("byte-limit");
	const bytes = Buffer.from(data);
	assertImagePixelBudget(bytes, MAX_SIDE * MAX_SIDE);
	const mimeType = sniffImageType(bytes);
	if (!mimeType) throw new ImagePreparationError("invalid-image");
	const image = await loadImage(bytes);
	if (
		bytes.byteLength <= MAX_RAW_BYTES &&
		Math.max(image.width, image.height) <= MAX_SIDE
	)
		return { data: bytes.toString("base64"), mimeType };
	const scale = DOWNSCALED_SIDE / Math.max(image.width, image.height);
	const width = Math.max(1, Math.round(image.width * Math.min(1, scale)));
	const height = Math.max(1, Math.round(image.height * Math.min(1, scale)));
	const canvas = createCanvas(width, height);
	canvas.getContext("2d").drawImage(image, 0, 0, width, height);
	return {
		data: canvas.toBuffer("image/jpeg", { quality: 0.85 }).toString("base64"),
		mimeType: "image/jpeg",
	};
}
