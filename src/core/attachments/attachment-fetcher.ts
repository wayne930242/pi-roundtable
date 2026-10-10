import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AttachmentFailure,
	AttachmentRef,
	StoredAttachment,
} from "../domain/attachment.ts";
import { plainText } from "./attachment-name.ts";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface FetchRequest {
	refs: readonly AttachmentRef[];
	/** Directory of the channel's attachment store; created when missing. */
	dir: string;
	/** Prefix that keeps files of different messages apart, such as the message ID. */
	prefix: string;
	fromReference: boolean;
}

export interface FetchResult {
	files: StoredAttachment[];
	failures: AttachmentFailure[];
}

/** The most UTF-8 bytes a stored name keeps; a file system takes 255 bytes for the whole file name. */
const MAX_NAME_BYTES = 150;

const utf8Length = (codePoint: number): number =>
	codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** The end of `text` that fits `max` UTF-8 bytes, cut on a code point. */
function lastBytes(text: string, max: number): string {
	const points = [...text];
	let bytes = 0;
	let start = points.length;
	while (start > 0) {
		const size = utf8Length(points[start - 1]?.codePointAt(0) ?? 0);
		if (bytes + size > max) break;
		bytes += size;
		start -= 1;
	}
	return points.slice(start).join("");
}

/**
 * Keeps a file name readable while removing path separators and control characters, and keeps the
 * end of a long name (its extension) within 150 UTF-8 bytes so a prefix and a record suffix still
 * fit the 255 bytes a file system takes.
 */
export function safeFileName(name: string): string {
	const cleaned = lastBytes(
		plainText(name.toWellFormed().normalize("NFC").replace(/[/\\]/g, "_")),
		MAX_NAME_BYTES,
	).replace(/^\.+/, "_");
	return cleaned || "file";
}

/** Downloads attachments one by one; a failed file is reported without stopping the others. */
export async function fetchAttachments(
	request: FetchRequest,
	fetchImpl: typeof fetch = fetch,
): Promise<FetchResult> {
	const files: StoredAttachment[] = [];
	const failures: AttachmentFailure[] = [];
	const { refs, dir, prefix, fromReference } = request;
	if (refs.length === 0) return { files, failures };
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	for (const [index, ref] of refs.entries()) {
		const fail = (reason: string) =>
			failures.push({ name: ref.name, reason, fromReference });
		if (ref.size > MAX_ATTACHMENT_BYTES) {
			fail(`larger than 25 MB (${ref.size} bytes)`);
			continue;
		}
		try {
			const response = await fetchImpl(ref.url);
			if (!response.ok) {
				await response.body?.cancel();
				fail(`download failed with HTTP ${response.status}`);
				continue;
			}
			const data = await readAttachmentBody(response);
			if (typeof data === "number") {
				fail(`larger than 25 MB (${data} bytes)`);
				continue;
			}
			const file = `${prefix}-${index}-${safeFileName(ref.name)}`;
			const path = join(dir, file);
			await Bun.write(path, data);
			files.push({
				name: ref.name,
				file,
				path,
				contentType:
					ref.contentType ||
					response.headers.get("content-type") ||
					"application/octet-stream",
				size: data.byteLength,
				fromReference,
			});
		} catch (error) {
			fail(`download failed: ${String(error)}`);
		}
	}
	return { files, failures };
}

/** Returns the bytes, or the observed size once the stream exceeds the limit. */
async function readAttachmentBody(
	response: Response,
): Promise<Uint8Array | number> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_ATTACHMENT_BYTES) {
				await reader.cancel();
				return size;
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
