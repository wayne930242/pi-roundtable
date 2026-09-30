import { createCanvas, loadImage } from "canvas";
import type { ModelImage, StoredAttachment } from "../domain/attachment.ts";

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
	const bytes = Buffer.from(await Bun.file(file.path).arrayBuffer());
	const mimeType = file.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (bytes.byteLength <= MAX_RAW_BYTES) {
		const image = await loadImage(bytes);
		if (Math.max(image.width, image.height) <= MAX_SIDE) {
			return { data: bytes.toString("base64"), mimeType };
		}
	}
	const image = await loadImage(bytes);
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
