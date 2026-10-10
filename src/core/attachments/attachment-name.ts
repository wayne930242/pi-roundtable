import { basename } from "node:path";

/**
 * Characters that must not reach a prompt or a file name as they are: controls, the line and
 * paragraph separators, and the bidi controls that reorder or hide the text around them.
 */
const UNSAFE_CHARS =
	/[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** `value` with each unsafe character replaced by an underscore. */
export function plainText(value: string): string {
	return value.replace(UNSAFE_CHARS, "_");
}

/** Whether `file` could be a name the attachment stores give out: one path segment, not hidden, no NUL. */
export function isAttachmentName(file: string): boolean {
	return (
		file !== "" &&
		basename(file) === file &&
		!file.startsWith(".") &&
		!file.includes("\0")
	);
}

const TYPE_GRAMMAR = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

/** `type` when it is a plain type/subtype, else the generic binary type, for a prompt to print. */
export function plainContentType(type: string): string {
	return TYPE_GRAMMAR.test(type) ? type : "application/octet-stream";
}
