import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AttachmentFailure,
	AttachmentRef,
	StoredAttachment,
} from "../domain/attachment.ts";

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

/** Keeps a file name readable while removing path separators and control characters. */
export function safeFileName(name: string): string {
	const cleaned = name
		.normalize("NFC")
		.replace(/[/\\\p{Cc}]/gu, "_")
		.replace(/^\.+/, "_")
		.slice(-120);
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
				fail(`download failed with HTTP ${response.status}`);
				continue;
			}
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.byteLength > MAX_ATTACHMENT_BYTES) {
				fail(`larger than 25 MB (${data.byteLength} bytes)`);
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
