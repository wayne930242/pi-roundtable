import { createCanvas, loadImage } from "canvas";
import type { ModelImage, StoredAttachment } from "../domain/attachment.ts";
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
export const MAX_IMAGES_PER_TURN = 4;
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
 * Headers and all GIF/WebP frames must fit 64 MP; encoded bytes must fit 25 MiB. */
export async function prepareImageBytes(
	data: Uint8Array,
	contentType: string,
): Promise<ModelImage> {
	if (data.byteLength > MAX_ATTACHMENT_BYTES)
		throw new ImagePreparationError("byte-limit");
	const bytes = Buffer.from(data);
	assertImagePixelBudget(bytes, MAX_SIDE * MAX_SIDE);
	const mimeType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
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
