import { join } from "node:path";
import { wasExpired } from "../attachments/attachment-expiry.ts";
import { MAX_ATTACHMENT_BYTES } from "../attachments/attachment-fetcher.ts";
import { isAttachmentName, plainText } from "../attachments/attachment-name.ts";
import { AttachmentExpiredError } from "../attachments/tool-attachment.ts";
import {
	ATTACHMENT_TEXT_LIMIT,
	readAttachmentText,
} from "./attachment-text.ts";

/** Characters returned per read; the model can ask for a later offset. */
export const READ_LIMIT = ATTACHMENT_TEXT_LIMIT;

export interface ReadResult {
	text: string;
	/** Characters in the whole extracted text. */
	total: number;
}

/**
 * Reads a stored attachment as text: plain text files directly, PDFs through unpdf.
 * Other files are refused with a message naming what can take them.
 * `file` must be a name inside `dir`; paths are rejected.
 */
export async function readAttachment(
	dir: string,
	file: string,
	offset = 0,
): Promise<ReadResult> {
	if (!isAttachmentName(file)) {
		throw new Error(`"${plainText(file)}" is not an attachment name`);
	}
	const handle = Bun.file(join(dir, file));
	if (!(await handle.exists())) {
		if (await wasExpired(dir, file))
			throw new AttachmentExpiredError(plainText(file));
		throw new Error(`no attachment named "${file}" in this channel`);
	}
	// A file a surface took past the default limit is for tools that take files, not for reading whole.
	if (handle.size > MAX_ATTACHMENT_BYTES)
		throw new Error(
			`"${plainText(file)}" is too large to read as text (${handle.size} bytes); it is kept as a file for tools that take files.`,
		);
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await handle.arrayBuffer());
	} catch {
		// A file system error names the path on the host; the model sees only the attachment's name.
		throw new Error(`"${plainText(file)}" could not be read`);
	}
	const { text, total } = await readAttachmentText({
		name: file,
		bytes,
		offset: Math.max(0, Math.floor(offset)),
		limit: READ_LIMIT,
	});
	return { text, total };
}
