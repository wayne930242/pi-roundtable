import {
	isModelImage,
	prepareImageBytes,
	sniffImageType,
} from "../attachments/image-prep.ts";
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
/** How long all the images of one call may take to download, whatever their number. */
const DEADLINE_MS = 20_000;
/** How many images are downloaded at once. */
const CONCURRENCY = 2;

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
 * accepts (by its declared type, and by its bytes, which give the type it is sent as), is over
 * `maxBytes` (by Discord's size or by what arrives), cannot be fetched, or cannot be decoded is
 * skipped with its reason; a candidate of a type the model does not accept does not count toward
 * `count`, and at most twice `count` are tried. Two are downloaded at once, and all of them share
 * one deadline: the candidates that are still to be fetched when it passes are skipped as
 * undownloadable. Bytes stay in memory and nothing about them is logged.
 */
export async function contextImages(
	candidates: readonly ChannelContextAttachment[],
	options: {
		count: number;
		maxBytes: number;
		fetchImpl?: typeof fetch;
		logger: Logger;
		/** Replaceable in tests; default 20 seconds. */
		deadlineMs?: number;
	},
): Promise<{ images: ModelImage[]; skipped: SkippedImage[] }> {
	const { count } = options;
	const deadline = AbortSignal.timeout(options.deadlineMs ?? DEADLINE_MS);
	const images: ModelImage[] = [];
	const skipped: SkippedImage[] = [];
	const skip = (file: ChannelContextAttachment, reason: SkippedReason) =>
		skipped.push({ messageId: file.messageId, name: file.name, reason });
	let tried = 0;
	let next = 0;
	while (images.length < count && next < candidates.length) {
		// Never start more downloads than there are images still wanted, so none is wasted.
		const batch: ChannelContextAttachment[] = [];
		const room = Math.min(CONCURRENCY, count - images.length);
		while (
			batch.length < room &&
			next < candidates.length &&
			tried < count * 2
		) {
			const file = candidates[next++] as ChannelContextAttachment;
			if (
				!isModelImage({ contentType: file.contentType }) ||
				!file.url.startsWith("https://")
			) {
				skip(file, "unsupported type");
				continue;
			}
			tried++;
			batch.push(file);
		}
		if (batch.length === 0) break;
		const fetched = await Promise.all(
			batch.map((file) => oneImage(file, options, deadline)),
		);
		for (const [index, result] of fetched.entries()) {
			const file = batch[index] as ChannelContextAttachment;
			if ("image" in result) images.push(result.image);
			else skip(file, result.skipped);
		}
	}
	return { images, skipped };
}

/** One candidate's image, or why it is skipped. */
async function oneImage(
	file: ChannelContextAttachment,
	options: {
		maxBytes: number;
		fetchImpl?: typeof fetch;
		logger: Logger;
	},
	deadline: AbortSignal,
): Promise<{ image: ModelImage } | { skipped: SkippedReason }> {
	const { maxBytes, logger, fetchImpl = fetch } = options;
	if (file.size > maxBytes) return { skipped: "too large" };
	if (deadline.aborted) return { skipped: "download failed" };
	let data: Uint8Array | undefined;
	try {
		const response = await fetchImpl(file.url, {
			signal: AbortSignal.any([
				deadline,
				AbortSignal.timeout(FETCH_TIMEOUT_MS),
			]),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return { skipped: "download failed" };
		}
		data = await boundedBody(response, maxBytes);
	} catch (error) {
		logger.warn({ err: error }, "channel context image not fetched");
		return { skipped: "download failed" };
	}
	if (!data) return { skipped: "too large" };
	// The bytes say what it is; Discord's type is a guess from the file's name.
	const type = sniffImageType(data);
	if (!type) return { skipped: "unsupported type" };
	try {
		return { image: await prepareImageBytes(data, type) };
	} catch (error) {
		logger.warn({ err: error }, "channel context image not decoded");
		return { skipped: "could not be decoded" };
	}
}
