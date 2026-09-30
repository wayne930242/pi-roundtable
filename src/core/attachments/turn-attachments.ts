import type { TurnAttachments } from "../domain/attachment.ts";
import type { InboundMessage } from "../domain/conversation.ts";
import type { Logger } from "../log.ts";
import { fetchAttachments } from "./attachment-fetcher.ts";
import {
	isModelImage,
	MAX_IMAGES_PER_TURN,
	prepareImage,
} from "./image-prep.ts";

/** Saves the message's and its reference's files, and turns up to four images into model images. */
export async function collectAttachments(
	message: InboundMessage,
	dir: string,
	options: { logger: Logger; fetchImpl?: typeof fetch },
): Promise<TurnAttachments> {
	const { fetchImpl, logger } = options;
	const own = await fetchAttachments(
		{
			refs: message.attachments,
			dir,
			prefix: message.messageId,
			fromReference: false,
		},
		fetchImpl,
	);
	const referenced = await fetchAttachments(
		{
			refs: message.reference?.attachments ?? [],
			dir,
			prefix: `${message.messageId}-ref`,
			fromReference: true,
		},
		fetchImpl,
	);
	const files = [...own.files, ...referenced.files];
	const failures = [...own.failures, ...referenced.failures];
	const images = [];
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
	if (files.length > 0 || failures.length > 0) {
		logger.info(
			{
				channel: message.channel,
				files: files.length,
				images: images.length,
				failures: failures.length,
			},
			"attachments received",
		);
	}
	return { files, images, failures };
}

/** Collects a message's attachments into `dir`, reporting the files that failed. */
export function attachmentsOf(
	message: InboundMessage,
	dir: string,
	logger: Logger,
	fetchImpl?: typeof fetch,
): Promise<TurnAttachments> {
	return collectAttachments(message, dir, {
		logger,
		...(fetchImpl ? { fetchImpl } : {}),
	});
}
