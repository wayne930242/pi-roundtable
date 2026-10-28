/** Reading the quoted and delimited pieces of a command line that do not nest: `$'…'` and here-documents. */

/** A line the lexer cannot place; the rule holds it whole. */
export class Unreadable extends Error {}

/** The escapes of `$'…'` that stand for one fixed character. */
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
};

/** The text of the `$'…'` string at `pos`, with the escapes bash decodes (`$'\x73udo'` is `sudo`), and where it ends. */
export function ansiQuoted(
	src: string,
	pos: number,
): { text: string; end: number } {
	let text = "";
	let i = pos + 2;
	while (i < src.length && src[i] !== "'") {
		if (src[i] !== "\\" || i + 1 >= src.length) {
			text += src[i];
			i++;
			continue;
		}
		const c = src[i + 1] as string;
		i += 2;
		const simple = ANSI_ESCAPES[c];
		if (simple !== undefined) text += simple;
		else if (/[0-7]/.test(c)) {
			const digits = /^[0-7]{0,2}/.exec(src.slice(i, i + 2))?.[0] ?? "";
			text += String.fromCharCode(Number.parseInt(c + digits, 8) & 0xff);
			i += digits.length;
		} else if (c === "x" || c === "u" || c === "U") {
			const max = c === "x" ? 2 : c === "u" ? 4 : 8;
			const hex = /^[0-9a-fA-F]*/.exec(src.slice(i, i + max))?.[0] ?? "";
			if (hex === "") text += `\\${c}`;
			else {
				const code = Number.parseInt(hex, 16);
				text += code <= 0x10ffff ? String.fromCodePoint(code) : "";
				i += hex.length;
			}
		} else if (c === "c" && i < src.length)
			text += String.fromCharCode((src.charCodeAt(i++) as number) & 0x1f);
		else text += c;
	}
	return { text, end: Math.min(i + 1, src.length) };
}

/** The here-document delimiter at `pos`, with its quotes removed, and where its word ends. */
export function readDelimiter(
	src: string,
	pos: number,
): { text: string; quoted: boolean; end: number } {
	let text = "";
	let quoted = false;
	let i = pos;
	while (i < src.length) {
		const c = src[i] as string;
		// Bash ends the word at a blank or newline only: `EOF\r` is a delimiter of its own.
		if (" \t\n;&|()<>".includes(c)) break;
		if (c === "'") {
			const close = src.indexOf("'", i + 1);
			const stop = close === -1 ? src.length : close;
			text += src.slice(i + 1, stop);
			i = stop + 1;
			quoted = true;
		} else if (c === '"') {
			for (i++; i < src.length && src[i] !== '"'; i++) {
				if (
					src[i] === "\\" &&
					i + 1 < src.length &&
					'"\\$`'.includes(src[i + 1] as string)
				)
					i++;
				text += src[i];
			}
			i++;
			quoted = true;
		} else if (c === "\\") {
			if (i + 1 < src.length) text += src[i + 1];
			i += 2;
			quoted = true;
		} else if (c === "$" && src[i + 1] === "'") {
			const found = ansiQuoted(src, i);
			text += found.text;
			i = found.end;
			quoted = true;
		} else {
			text += c;
			i++;
		}
	}
	// `<<` followed by nothing, or by an operator, names no delimiter bash would accept.
	if (text === "" && !quoted) throw new Unreadable();
	return { text, quoted, end: Math.min(i, src.length) };
}

/**
 * Where the body of the here-document that starts at `start` ends (`bodyEnd`) and where the text
 * after its delimiter line begins (`next`). Without a delimiter line the body runs to the end.
 */
export function heredocBody(
	src: string,
	start: number,
	here: { delimiter: string; quoted: boolean; stripTabs: boolean },
): { bodyEnd: number; next: number } {
	let at = start;
	while (at < src.length) {
		const nl = src.indexOf("\n", at);
		const lineEnd = nl === -1 ? src.length : nl;
		const line = src.slice(at, lineEnd);
		if ((here.stripTabs ? line.replace(/^\t+/, "") : line) === here.delimiter)
			return { bodyEnd: at, next: nl === -1 ? src.length : nl + 1 };
		// A continued line may join the delimiter line; bash and this lexer might disagree.
		if (!here.quoted && /(?:^|[^\\])(?:\\\\)*\\$/.test(line)) {
			const after = src.slice(
				lineEnd + 1,
				src.indexOf("\n", lineEnd + 1) + 1 || src.length,
			);
			if (after.replace(/\n$/, "") === here.delimiter) throw new Unreadable();
		}
		if (nl === -1) break;
		at = nl + 1;
	}
	return { bodyEnd: src.length, next: src.length };
}
