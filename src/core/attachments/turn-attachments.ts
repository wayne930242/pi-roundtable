import type { TurnAttachments } from "../domain/attachment.ts";
import type { InboundMessage } from "../domain/conversation.ts";
import type { Logger } from "../log.ts";
import { fetchAttachments } from "./attachment-fetcher.ts";
import { modelImagesOf } from "./model-images.ts";

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
	const prepared = await modelImagesOf(files, logger);
	const images = prepared.images;
	failures.push(...prepared.failures);
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
