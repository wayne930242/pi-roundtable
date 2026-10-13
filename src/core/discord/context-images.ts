import { isModelImage, prepareImageBytes } from "../attachments/image-prep.ts";
import type { ChannelContextAttachment } from "../contract/channel-context.ts";
import type { ModelImage } from "../domain/attachment.ts";
import type { Logger } from "../log.ts";

/** Why an image of a channel message was not attached to the turn; fixed words, never an error's text. */
export type SkippedReason =
	| "unsupported type"
	| "too large"
	| "download failed"
	| "could not be decoded";

export interface SkippedImage {
	messageId: string;
	name: string;
	reason: SkippedReason;
}

/** How long one image may take to download. */
const FETCH_TIMEOUT_MS = 15_000;

/** The bytes of a response, or undefined once they pass `max`. */
async function boundedBody(
	response: Response,
	max: number,
): Promise<Uint8Array | undefined> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return data;
}

/**
 * Fetches up to `count` of the candidates' images, in the order given, and prepares them as a
 * turn's own images are (see `prepareImageBytes`). A candidate that is not an image the model
 * accepts, is over `maxBytes` (by Discord's size or by what arrives), cannot be fetched, or cannot
 * be decoded is skipped with its reason; a candidate of a type the model does not accept does not
 * count toward `count`, and at most twice `count` are tried. Bytes stay in memory and nothing about
 * them is logged.
 */
export async function contextImages(
	candidates: readonly ChannelContextAttachment[],
	options: {
		count: number;
		maxBytes: number;
		fetchImpl?: typeof fetch;
		logger: Logger;
	},
): Promise<{ images: ModelImage[]; skipped: SkippedImage[] }> {
	const { count, maxBytes, logger, fetchImpl = fetch } = options;
	const images: ModelImage[] = [];
	const skipped: SkippedImage[] = [];
	let tried = 0;
	for (const file of candidates) {
		if (images.length >= count || tried >= count * 2) break;
		const skip = (reason: SkippedReason) =>
			skipped.push({ messageId: file.messageId, name: file.name, reason });
		if (
			!isModelImage({ contentType: file.contentType }) ||
			!file.url.startsWith("https://")
		) {
			skip("unsupported type");
			continue;
		}
		tried++;
		if (file.size > maxBytes) {
			skip("too large");
			continue;
		}
		let data: Uint8Array | undefined;
		try {
			const response = await fetchImpl(file.url, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!response.ok) {
				await response.body?.cancel();
				skip("download failed");
				continue;
			}
			data = await boundedBody(response, maxBytes);
		} catch (error) {
			logger.warn({ err: error }, "channel context image not fetched");
			skip("download failed");
			continue;
		}
		if (!data) {
			skip("too large");
			continue;
		}
		try {
			images.push(await prepareImageBytes(data, file.contentType));
		} catch (error) {
			logger.warn({ err: error }, "channel context image not decoded");
			skip("could not be decoded");
		}
	}
	return { images, skipped };
}
