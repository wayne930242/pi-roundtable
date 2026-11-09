import { createHash } from "node:crypto";
import { HEAD_BYTES } from "./workspace-model.ts";
export const hashOf = (data: Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

// The byte order mark is stripped by hand, once: a second one is text and stays.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** What a file's bytes are, for the view and for a save. */
export function classify(bytes: Uint8Array): {
	binary: boolean;
	text?: string;
	bom: boolean;
	eol: "\n" | "\r\n";
	notUtf8: boolean;
} {
	const head = bytes.subarray(0, HEAD_BYTES);
	const base = { bom: false, eol: "\n" as const };
	if (head.includes(0)) return { ...base, binary: true, notUtf8: false };
	const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	let text: string;
	try {
		text = decoder.decode(bom ? bytes.subarray(3) : bytes);
	} catch {
		return { ...base, binary: false, notUtf8: true };
	}
	let crlf = 0;
	let lf = 0;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
		if (text[i - 1] === "\r") crlf++;
		else lf++;
	return {
		binary: false,
		notUtf8: false,
		text,
		bom,
		eol: crlf > lf ? "\r\n" : "\n",
	};
}
