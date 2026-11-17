import type { Client } from "discord.js";
import { boundedBody } from "./context-images.ts";

/** Which file `DISCORD.readAttachment` reads: one attachment of one message in a channel the caller names. */
export interface AttachmentReadRequest {
	/** The channel (or thread) the message is in. A message of another channel is not found. */
	channelId: string;
	/** The message that carries the file; a forward carries the forwarded message's files. */
	messageId: string;
	/** Discord's id of the file, as `AttachmentRef.id` and channel context's attachment lines give it. */
	attachmentId: string;
	/** The most bytes read for this call; it may lower the host's `discord.attachmentRead.maxBytes`, never raise it. */
	maxBytes?: number;
}

/** One file's bytes, read from Discord as it is now. */
export interface AttachmentBytes {
	/** The file's id, as asked for. */
	id: string;
	name: string;
	/** Empty when Discord does not say. */
	contentType: string;
	/** The number of bytes read, which is `bytes.byteLength`. */
	size: number;
	bytes: Uint8Array;
	/** The title the uploader gave it, when there is one. */
	title?: string;
	/** The description the uploader gave it, such as its alt text, when there is one. */
	description?: string;
}

/**
 * Why a file was not read: `not-found` (no such channel, message, or file on the message, or one
 * the bot cannot see), `too-large` (over the cap, by Discord's size or by what arrived), `gone`
 * (Discord's CDN no longer serves it), `unavailable` (Discord is not connected, did not answer in
 * time, or answered with another error; trying later may work).
 */
export type AttachmentReadErrorCode =
	| "not-found"
	| "too-large"
	| "gone"
	| "unavailable";

/** What `DISCORD.readAttachment` rejects with; `message` names the request, never the file's URL. */
export class AttachmentReadError extends Error {
	readonly code: AttachmentReadErrorCode;
	constructor(code: AttachmentReadErrorCode, message: string) {
		super(message);
		this.name = "AttachmentReadError";
		this.code = code;
	}
}

/** The host's cap on one read when `discord.attachmentRead.maxBytes` is left out: 10 MiB. */
export const ATTACHMENT_READ_MAX_BYTES = 10 * 1024 * 1024;
/** How long one file's download may take. */
const READ_TIMEOUT_MS = 30_000;

/** A file of a message as Discord describes it now, with a fresh, signed URL. */
export interface AttachmentFacts {
	id: string;
	name: string;
	contentType: string | null;
	size: number;
	url: string;
	title?: string | null;
	description?: string | null;
}

/** Where `readAttachment` looks a message up; replaceable in tests. */
export interface AttachmentSource {
	/**
	 * The message's files, its own and those of a message it forwards; undefined when the channel
	 * or the message does not exist, is not a message channel, or the bot cannot read it. Throws
	 * when Discord cannot be asked.
	 */
	files(
		channelId: string,
		messageId: string,
	): Promise<readonly AttachmentFacts[] | undefined>;
}

/** The hosts Discord serves attachments from; a URL elsewhere is never fetched. */
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/**
 * One attachment's bytes: the message is fetched again (so its URL is fresh and Discord's, never
 * one a caller or a model supplied), the file is found by its id, and its bytes are downloaded up
 * to `maxBytes`. Rejects with an `AttachmentReadError`.
 */
export async function readAttachment(
	source: AttachmentSource,
	request: AttachmentReadRequest,
	options: { maxBytes: number; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<AttachmentBytes> {
	const { channelId, messageId, attachmentId } = request;
	const what = `attachment ${attachmentId} of message ${messageId} in channel ${channelId}`;
	for (const [name, value] of Object.entries({
		channelId,
		messageId,
		attachmentId,
	}))
		if (typeof value !== "string" || !/^\d{1,25}$/.test(value))
			throw new AttachmentReadError("not-found", `${name} is not a Discord id`);
	const max = Math.min(
		options.maxBytes,
		request.maxBytes === undefined
			? Number.POSITIVE_INFINITY
			: request.maxBytes,
	);
	if (!Number.isInteger(max) || max < 1)
		throw new RangeError("maxBytes must be a positive integer");
	let files: readonly AttachmentFacts[] | undefined;
	try {
		files = await source.files(channelId, messageId);
	} catch {
		throw new AttachmentReadError(
			"unavailable",
			`${what}: Discord could not be asked for the message`,
		);
	}
	const file = files?.find((found) => found.id === attachmentId);
	if (!file)
		throw new AttachmentReadError(
			"not-found",
			`${what}: ${files ? "the message has no such file" : "no such message the bot can read"}`,
		);
	const tooLarge = () =>
		new AttachmentReadError("too-large", `${what}: larger than ${max} bytes`);
	if (file.size > max) throw tooLarge();
	const url = safeUrl(file.url);
	if (!url)
		throw new AttachmentReadError(
			"unavailable",
			`${what}: Discord gave no CDN address for it`,
		);
	const signal = AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS);
	let bytes: Uint8Array | undefined;
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			signal,
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new AttachmentReadError(
				[403, 404, 410].includes(response.status) ? "gone" : "unavailable",
				`${what}: Discord's CDN answered ${response.status}`,
			);
		}
		bytes = await boundedBody(response, max);
	} catch (error) {
		if (error instanceof AttachmentReadError) throw error;
		throw new AttachmentReadError(
			"unavailable",
			`${what}: the download failed${signal.aborted ? " (timed out)" : ""}`,
		);
	}
	if (!bytes) throw tooLarge();
	return {
		id: file.id,
		name: file.name,
		contentType: file.contentType ?? "",
		size: bytes.byteLength,
		bytes,
		...(file.title ? { title: file.title } : {}),
		...(file.description ? { description: file.description } : {}),
	};
}

function safeUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && CDN_HOSTS.has(url.hostname)
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/** Discord's codes for a channel or message that is not there or not the bot's to read. */
const MISSING = new Set([10003, 10008, 50001, 50013]);

/** The messages of the Discord client, as `readAttachment` looks them up. */
export function discordAttachmentSource(client: Client): AttachmentSource {
	return {
		files: async (channelId, messageId) => {
			if (!client.isReady()) throw new Error("Discord is not connected");
			try {
				const channel = await client.channels.fetch(channelId);
				if (!channel?.isTextBased()) return undefined;
				// Fetched from Discord, not the cache, so the URLs are freshly signed.
				const message = await channel.messages.fetch({
					message: messageId,
					force: true,
				});
				return [
					...message.attachments.values(),
					...[...message.messageSnapshots.values()].flatMap((snapshot) => [
						...snapshot.attachments.values(),
					]),
				];
			} catch (error) {
				const code = (error as { code?: unknown } | null)?.code;
				if (typeof code === "number" && MISSING.has(code)) return undefined;
				throw error;
			}
		},
	};
}
