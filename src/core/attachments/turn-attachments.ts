import type { AttachmentRef, TurnAttachments } from "../domain/attachment.ts";
import type { InboundMessage } from "../domain/conversation.ts";
import type { Logger } from "../log.ts";
import { fetchAttachments } from "./attachment-fetcher.ts";
import { modelImagesOf } from "./model-images.ts";

/**
 * The most milliseconds all of a message's downloads take together by default. A download that
 * stalls ends at `DEFAULT_IDLE_MS` without bytes, so the deadline only has to cover slow ones.
 */
export const DEFAULT_DEADLINE_MS = 60_000;

/** Saves the message's and its reference's files, and turns up to four images into model images. */
export async function collectAttachments(
	message: InboundMessage,
	dir: string,
	options: {
		logger: Logger;
		fetchImpl?: typeof fetch;
		/** One deadline for the message's and its reference's files together; default 60 s. */
		deadlineMs?: number;
		/** How long one file may send no byte before it is given up and the next one tried; default 10 s. */
		idleMs?: number;
		/** Aborts the downloads, as the deadline does. */
		signal?: AbortSignal;
		/**
		 * Whether images are decoded for the model; default true. False downloads the files only:
		 * `images` is empty and an image that cannot be decoded is no failure, for a host that hands
		 * the files on to something that prepares them itself.
		 */
		prepareImages?: boolean;
		/**
		 * Reads a ref through the surface that made it. A function that answers a promise is the
		 * ref's only source: it is never fetched, and a rejection fails that file. `undefined` = the
		 * surface has no reader, and the ref's URL is downloaded.
		 */
		read?: (ref: AttachmentRef) => Promise<Uint8Array> | undefined;
	},
): Promise<TurnAttachments> {
	const { fetchImpl, logger } = options;
	const deadline = AbortSignal.timeout(
		options.deadlineMs ?? DEFAULT_DEADLINE_MS,
	);
	const signal = options.signal
		? AbortSignal.any([deadline, options.signal])
		: deadline;
	const idle = {
		...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
		...(options.read ? { read: options.read } : {}),
	};
	const own = await fetchAttachments(
		{
			refs: message.attachments,
			dir,
			prefix: message.messageId,
			fromReference: false,
			signal,
			...idle,
		},
		fetchImpl,
	);
	const referenced = await fetchAttachments(
		{
			refs: message.reference?.attachments ?? [],
			dir,
			prefix: `${message.messageId}-ref`,
			fromReference: true,
			signal,
			...idle,
		},
		fetchImpl,
	);
	const files = [...own.files, ...referenced.files];
	const failures = [...own.failures, ...referenced.failures];
	const prepared =
		options.prepareImages === false
			? { images: [], failures: [] }
			: await modelImagesOf(files, logger);
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

/**
 * Collects a message's attachments into `dir`, reporting the files that failed. `prepareImages:
 * false` downloads the files only, without decoding the images for the model.
 */
export function attachmentsOf(
	message: InboundMessage,
	dir: string,
	logger: Logger,
	fetchImpl?: typeof fetch,
	limits: {
		deadlineMs?: number;
		idleMs?: number;
		signal?: AbortSignal;
		prepareImages?: boolean;
		read?: (ref: AttachmentRef) => Promise<Uint8Array> | undefined;
	} = {},
): Promise<TurnAttachments> {
	return collectAttachments(message, dir, {
		logger,
		...limits,
		...(fetchImpl ? { fetchImpl } : {}),
	});
}
