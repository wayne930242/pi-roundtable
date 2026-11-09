/** How much of the start of a file is read to tell whether it is an SVG: room for a long prolog. */
export const SVG_HEAD_BYTES = 4096;

const WHITESPACE = /^[\t\n\r ]+/;
const ROOT = /^<svg(?=[\t\n\r />])/;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The end of the root's start tag, past quoted values; the text's end when it is cut off. */
function tagEnd(rest: string): number {
	let quote = "";
	for (let at = 0; at < rest.length; at++) {
		const char = rest[at] ?? "";
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") quote = char;
		else if (char === ">") return at;
	}
	return rest.length;
}

/** Whether the root's own default namespace, when it sets one, is SVG's: an XHTML root renders as a page. */
function rootNamespaceOk(rest: string): boolean {
	const tag = rest.slice(0, tagEnd(rest));
	const set = /[\t\n\r ]xmlns[\t\n\r ]*=[\t\n\r ]*(?:"([^"]*)"|'([^']*)')/.exec(
		tag,
	);
	return set === null || (set[1] ?? set[2]) === SVG_NAMESPACE;
}

/** The index after the `>` that closes a doctype, which may hold a `[ ... ]` subset; -1 when the text ends first. */
function afterDoctype(text: string, from: number): number {
	let depth = 0;
	for (let at = from; at < text.length; at++) {
		const char = text[at];
		if (char === "[") depth++;
		else if (char === "]") depth--;
		else if (char === ">" && depth <= 0) return at + 1;
	}
	return -1;
}

/**
 * Whether the first bytes are an SVG document: an optional byte order mark and whitespace, an
 * optional `<?xml ?>` declaration, comments and a doctype, then the `<svg` root. A file whose
 * `<svg` comes later, as in the body of an HTML page, is not one; neither is one whose prolog
 * runs past `head`.
 */
export function isSvg(head: Uint8Array): boolean {
	const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
	const text = new TextDecoder("latin1").decode(head.subarray(bom));
	let at = 0;
	for (;;) {
		at += WHITESPACE.exec(text.slice(at))?.[0].length ?? 0;
		const rest = text.slice(at);
		if (ROOT.test(rest)) return rootNamespaceOk(rest);
		let end: number;
		if (rest.startsWith("<?")) {
			end = rest.indexOf("?>");
			if (end < 0) return false;
			end += 2;
		} else if (rest.startsWith("<!--")) {
			end = rest.indexOf("-->");
			if (end < 0) return false;
			end += 3;
		} else if (/^<!DOCTYPE/i.test(rest)) {
			end = afterDoctype(rest, 9);
			if (end < 0) return false;
		} else return false;
		at += end;
	}
}
