import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { isAttachmentName, plainText } from "../attachments/attachment-name.ts";

/** Characters returned per read; the model can ask for a later offset. */
export const READ_LIMIT = 60_000;

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

function extension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function isPdf(name: string, head: Uint8Array): boolean {
	return (
		extension(name) === ".pdf" ||
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
		throw new Error(`no attachment named "${file}" in this channel`);
	}
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await handle.arrayBuffer());
	} catch {
		// A file system error names the path on the host; the model sees only the attachment's name.
		throw new Error(`"${plainText(file)}" could not be read`);
	}
	let text: string;
	if (isPdf(file, bytes)) {
		const pdf = await getDocumentProxy(bytes);
		const result = await extractText(pdf, { mergePages: true });
		text = `[PDF, ${result.totalPages} pages]\n${result.text}`;
	} else if (TEXT_EXTENSIONS.has(extension(file)) || looksLikeText(bytes)) {
		text = new TextDecoder().decode(bytes);
	} else {
		throw new Error(
			`"${file}" is not a text or PDF file (${bytes.byteLength} bytes). Images are shown to you directly; audio or video can go to a tool that takes files.`,
		);
	}
	const start = Math.max(0, Math.floor(offset));
	return { text: text.slice(start, start + READ_LIMIT), total: text.length };
}
