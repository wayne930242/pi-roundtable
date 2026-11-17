import { extractText, getDocumentProxy } from "unpdf";
import { plainText } from "../attachments/attachment-name.ts";

/** Characters one read returns by default, as the core's `read_attachment` tool reads; ask for a later `offset` for more. */
export const ATTACHMENT_TEXT_LIMIT = 60_000;

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".csv",
	".tsv",
	".json",
	".yaml",
	".yml",
	".xml",
	".html",
	".htm",
	".log",
	".ts",
	".js",
	".py",
	".sh",
	".toml",
	".ini",
	".srt",
	".vtt",
]);

const TEXT_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
]);

function extension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** The media type without its parameters, lowercased; empty when none is given. */
const mediaType = (contentType: string | null | undefined) =>
	(contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

function isPdf(name: string, type: string, head: Uint8Array): boolean {
	return (
		extension(name) === ".pdf" ||
		type === "application/pdf" ||
		new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-"
	);
}

function looksLikeText(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 4096);
	if (sample.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(sample);
		return true;
	} catch {
		return false;
	}
}

/** A file to read as text: its name, its media type when known, and its bytes. */
export interface AttachmentTextRequest {
	name: string;
	contentType?: string | null;
	bytes: Uint8Array;
	/** The character to start from; default 0. */
	offset?: number;
	/** The most characters returned; default `ATTACHMENT_TEXT_LIMIT`, 60,000. */
	limit?: number;
}

/** One piece of a file's text. */
export interface AttachmentText {
	/** `pdf` when the text was extracted from a PDF, else `text`. */
	kind: "text" | "pdf";
	/** The characters from `offset`, at most `limit` of them; a PDF's text starts with `[PDF, <n> pages]`. */
	text: string;
	/** Where this piece starts. */
	offset: number;
	/** Where the next piece starts; absent when this piece reaches the end. */
	nextOffset?: number;
	/** Characters in the whole text. */
	total: number;
	/** A PDF's page count. */
	pages?: number;
}

/**
 * Why a file was not read as text: `unsupported` (not text or a PDF, such as an image, audio or an
 * archive), `unreadable` (a PDF that could not be parsed), `invalid` (an `offset` or `limit` that
 * is not a whole number, or a `limit` below 1).
 */
export type AttachmentTextErrorCode = "unsupported" | "unreadable" | "invalid";

/** What `readAttachmentText` rejects with; `message` names the file, never its bytes. */
export class AttachmentTextError extends Error {
	readonly code: AttachmentTextErrorCode;
	constructor(code: AttachmentTextErrorCode, message: string) {
		super(message);
		this.name = "AttachmentTextError";
		this.code = code;
	}
}

/**
 * A file's bytes as text, one piece at a time: a text file is decoded as UTF-8, a PDF's text is
 * extracted, and anything else is refused with an `AttachmentTextError`. It is how the core's
 * `read_attachment` tool reads, so a plugin that has a file's bytes (for example from
 * `DISCORD.readAttachment`) reads it the same way.
 */
export async function readAttachmentText(
	request: AttachmentTextRequest,
): Promise<AttachmentText> {
	const { name, bytes } = request;
	const offset = request.offset ?? 0;
	const limit = request.limit ?? ATTACHMENT_TEXT_LIMIT;
	if (!Number.isInteger(offset) || offset < 0)
		throw new AttachmentTextError(
			"invalid",
			"offset must be a whole number from 0",
		);
	if (!Number.isInteger(limit) || limit < 1)
		throw new AttachmentTextError(
			"invalid",
			"limit must be a positive whole number",
		);
	const type = mediaType(request.contentType);
	let kind: AttachmentText["kind"];
	let text: string;
	let pages: number | undefined;
	if (isPdf(name, type, bytes)) {
		let result: { totalPages: number; text: string };
		try {
			result = await extractText(await getDocumentProxy(bytes), {
				mergePages: true,
			});
		} catch {
			throw new AttachmentTextError(
				"unreadable",
				`"${plainText(name)}" could not be read as a PDF`,
			);
		}
		kind = "pdf";
		pages = result.totalPages;
		text = `[PDF, ${result.totalPages} pages]\n${result.text}`;
	} else if (
		TEXT_EXTENSIONS.has(extension(name)) ||
		type.startsWith("text/") ||
		TEXT_TYPES.has(type) ||
		looksLikeText(bytes)
	) {
		kind = "text";
		text = new TextDecoder().decode(bytes);
	} else {
		throw new AttachmentTextError(
			"unsupported",
			`"${plainText(name)}" is not a text or PDF file (${bytes.byteLength} bytes). Images are shown to you directly; audio or video can go to a tool that takes files.`,
		);
	}
	const end = Math.min(text.length, offset + limit);
	return {
		kind,
		text: text.slice(offset, end),
		offset,
		...(end < text.length ? { nextOffset: end } : {}),
		total: text.length,
		...(pages === undefined ? {} : { pages }),
	};
}
