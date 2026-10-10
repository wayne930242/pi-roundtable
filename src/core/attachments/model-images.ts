import type {
	AttachmentFailure,
	ModelImage,
	StoredAttachment,
} from "../domain/attachment.ts";
import type { Logger } from "../log.ts";
import {
	isModelImage,
	MAX_IMAGES_PER_TURN,
	prepareImage,
} from "./image-prep.ts";

/**
 * The first four images among the files, prepared as the model accepts them. An image that cannot
 * be decoded is reported as a failure and the turn goes on without it.
 */
export async function modelImagesOf(
	files: readonly StoredAttachment[],
	logger: Logger,
): Promise<{ images: ModelImage[]; failures: AttachmentFailure[] }> {
	const images: ModelImage[] = [];
	const failures: AttachmentFailure[] = [];
	for (const file of files.filter(isModelImage).slice(0, MAX_IMAGES_PER_TURN)) {
		try {
			images.push(await prepareImage(file));
		} catch (error) {
			logger.warn(
				{ file: file.file, err: error },
				"image could not be prepared",
			);
			failures.push({
				name: file.name,
				reason: "the image could not be decoded",
				fromReference: file.fromReference,
			});
		}
	}
	return { images, failures };
}
