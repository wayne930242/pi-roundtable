import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { InboundMessage, TurnAttachments } from "pi-roundtable";
import { openDirectoryFile, ownDirectory } from "./directory-file.ts";
import type { PiImage } from "./pi-protocol.ts";
import { safeFetch } from "./safe-fetch.ts";

export interface PiAttachmentOptions {
	/** Trusted image-preparation hook receives bytes, never a guest-writable path. */
	prepareImage(data: Uint8Array, mimeType: string): Promise<PiImage>;
	/** Test-only fixture transport; production uses pinned safeFetch. */
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	/** Trusted presentation adapter for a failure; return undefined to keep the default wording. */
	describeFailure?(error: unknown): string | undefined;
}
/** A failure whose message is already safe to show, matching the core's attachment wording. */
class AttachmentRefused extends Error {}
/** Bounded downloads and no-follow, descriptor-anchored writes into a guest-writable directory. */
export async function collectPiAttachments(
	message: InboundMessage,
	dir: string,
	options: PiAttachmentOptions,
): Promise<TurnAttachments> {
	// The guest owns this directory's contents, so a planted symlink is replaced rather than followed.
	ownDirectory(dir);
	const directory = openSync(
		dir,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	const files: TurnAttachments["files"][number][] = [];
	const failures: TurnAttachments["failures"][number][] = [];
	const images: PiImage[] = [];
	let total = 0;
	const refs = [
		...message.attachments.map((ref, index) => ({
			ref,
			index,
			prefix: message.messageId,
			fromReference: false,
		})),
		...(message.reference?.attachments ?? []).map((ref, index) => ({
			ref,
			index,
			prefix: `${message.messageId}-ref`,
			fromReference: true,
		})),
	];
	try {
		for (const [
			order,
			{ ref, index, prefix, fromReference },
		] of refs.entries()) {
			try {
				options.signal?.throwIfAborted();
				if (order >= 20) throw new AttachmentRefused("too many attachments");
				if (ref.size > 25 * 1024 * 1024)
					throw new AttachmentRefused(`larger than 25 MB (${ref.size} bytes)`);
				const fetched = options.fetchImpl
					? await options.fetchImpl(ref.url, { signal: options.signal })
					: undefined;
				const result = fetched
					? {
							status: fetched.status,
							headers: fetched.headers,
							data: new Uint8Array(await fetched.arrayBuffer()),
						}
					: await safeFetch(ref.url, {
							signal: options.signal,
							maxBytes: 25 * 1024 * 1024,
						});
				if (result.status < 200 || result.status >= 300)
					throw new AttachmentRefused(
						`download failed with HTTP ${result.status}`,
					);
				total += result.data.byteLength;
				if (result.data.byteLength > 25 * 1024 * 1024)
					throw new AttachmentRefused(
						`larger than 25 MB (${result.data.byteLength} bytes)`,
					);
				if (total > 50 * 1024 * 1024)
					throw new AttachmentRefused("attachments exceed 50 MB in total");
				if (!/^[a-zA-Z0-9_-]{1,160}$/.test(prefix))
					throw new Error("Invalid message id");
				const name =
					ref.name
						.normalize("NFC")
						.replace(/[/\\\p{Cc}]/gu, "_")
						.replace(/^\.+/, "_")
						.slice(-120) || "file";
				const file = `${prefix}-${index}-${name}`;
				const path = join(dir, file);
				const fd = await openDirectoryFile(
					directory,
					file,
					constants.O_WRONLY |
						constants.O_CREAT |
						constants.O_EXCL |
						constants.O_NOFOLLOW,
					0o600,
				);
				try {
					let written = 0;
					while (written < result.data.length)
						written += writeSync(
							fd,
							result.data,
							written,
							result.data.length - written,
						);
				} finally {
					closeSync(fd);
				}
				const contentType =
					ref.contentType ||
					result.headers.get("content-type") ||
					"application/octet-stream";
				files.push({
					name: ref.name,
					file,
					path,
					contentType,
					size: result.data.byteLength,
					fromReference,
				});
				const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
				if (
					images.length < 4 &&
					["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)
				) {
					try {
						images.push(await options.prepareImage(result.data, mime));
					} catch (error) {
						failures.push({
							name: ref.name,
							reason:
								options.describeFailure?.(error) ??
								"the image could not be decoded",
							fromReference,
						});
					}
				}
			} catch (error) {
				failures.push({
					name: ref.name,
					reason:
						options.describeFailure?.(error) ??
						(error instanceof AttachmentRefused
							? error.message
							: `download failed: ${String(error)}`),
					fromReference,
				});
			}
		}
		return { files, failures, images };
	} finally {
		closeSync(directory);
	}
}
