import { join } from "node:path";
import { RECORDS } from "./attachment-dir.ts";
import { expiredMessage, wasExpired } from "./attachment-expiry.ts";
import { isAttachmentName, plainText } from "./attachment-name.ts";

/** A file someone attached to the conversation, as a tool reads it. */
export interface ToolAttachment {
	/** The file name inside the conversation's attachment store; what `## Attachments` lists. */
	file: string;
	/** The name the person gave it, when the core recorded one; else the file name. */
	name: string;
	contentType: string;
	size: number;
	/** The file's whole content. */
	bytes(): Promise<Uint8Array>;
}

/** A name that is no attachment of the conversation, or a file that is not there. */
export class AttachmentLookupError extends Error {
	override name = "AttachmentLookupError";
}

/** A file the core removed after its retention period; the message says so, with no path. */
export class AttachmentExpiredError extends AttachmentLookupError {
	override name = "AttachmentExpiredError";

	constructor(shown: string) {
		super(expiredMessage(shown));
	}
}

interface Recorded {
	name?: unknown;
	contentType?: unknown;
}

/**
 * Opens one attachment of a conversation's store for a tool. `file` must be a name in `dir`, as
 * `read_attachment` takes it: a path or a hidden name is refused.
 */
export async function openAttachment(
	dir: string,
	file: string,
): Promise<ToolAttachment> {
	const shown = plainText(file);
	if (!isAttachmentName(file))
		throw new AttachmentLookupError(`"${shown}" is not an attachment name`);
	const handle = Bun.file(join(dir, file));
	if (!(await handle.exists())) {
		if (await wasExpired(dir, file)) throw new AttachmentExpiredError(shown);
		throw new AttachmentLookupError(
			`no attachment named "${shown}" in this channel`,
		);
	}
	const record = Bun.file(join(dir, RECORDS, `${file}.json`));
	const recorded: Recorded = (await record.exists()) ? await record.json() : {};
	return {
		file,
		name: typeof recorded.name === "string" ? recorded.name : file,
		contentType:
			typeof recorded.contentType === "string"
				? recorded.contentType
				: handle.type,
		size: handle.size,
		// A file system error names the path on the host; the model sees only the attachment's name.
		bytes: async () => {
			try {
				return new Uint8Array(await handle.arrayBuffer());
			} catch {
				throw new AttachmentLookupError(`"${shown}" could not be read`);
			}
		},
	};
}
