/** Reading the quoted and delimited pieces of a command line that do not nest: `$'…'` and here-documents. */

/** Whether a line continuation follows a character that starts a longer token (`$\⏎(`, `<<\⏎EOF`). */
export function continuedToken(src: string): boolean {
	return /[$<>{,(]\\\n/.test(src);
}

/**
 * Whether the `}` at `pos` closes a group: a word of its own after a separator. Any other `{` or
 * `}` is part of a word, which may be a brace expansion such as `{sudo,ls}`.
 */
export function closesGroup(src: string, pos: number): boolean {
	const before = src[pos - 1];
	const after = src[pos + 1];
	const space = (ch: string) => /\s/.test(ch);
	return (
		(before === undefined || space(before) || ";&|()".includes(before)) &&
		(after === undefined || space(after) || ";&|()<>".includes(after))
	);
}

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
		else if ("\\'\"?".includes(c)) text += c;
		// Any other escape stays as it is, backslash and all: `$'s\⏎udo'` is `s\⏎udo`, which `eval` joins.
		else text += `\\${c}`;
	}
	// A NUL ends the string: `$'sudo\0x'` is `sudo`.
	const nul = text.indexOf("\0");
	return {
		text: nul === -1 ? text : text.slice(0, nul),
		end: Math.min(i + 1, src.length),
	};
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
				if (src[i] === "\\" && src[i + 1] === "\n") throw new Unreadable();
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
			// Bash joins a backslash and a newline out of the word; no one writes one in a delimiter.
			if (src[i + 1] === "\n") throw new Unreadable();
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
	// `<<` followed by nothing, by an operator, or by `""` names no delimiter: bash versions end
	// such a body, and the substitution around it, in different places.
	if (text === "") throw new Unreadable();
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
): { bodyEnd: number; next: number; terminated: boolean } {
	let at = start;
	// Joining continuation lines is bounded by the delimiter length per start and by a total step
	// budget; a body that exhausts it is unreadable (held) instead of quadratic.
	let budget = 4 * src.length + 1000;
	const limit = here.delimiter.length;
	while (at < src.length) {
		const nl = src.indexOf("\n", at);
		const lineEnd = nl === -1 ? src.length : nl;
		const line = src.slice(at, lineEnd);
		if ((here.stripTabs ? line.replace(/^\t+/, "") : line) === here.delimiter)
			return {
				bodyEnd: at,
				next: nl === -1 ? src.length : nl + 1,
				terminated: true,
			};
		// A continued line may join the delimiter line; bash and this lexer might disagree.
		if (!here.quoted) {
			let joined = line;
			let end = lineEnd;
			while (/(?:^|[^\\])(?:\\\\)*\\$/.test(joined) && end < src.length) {
				if (--budget < 0) throw new Unreadable();
				const stop = src.indexOf("\n", end + 1);
				const nextEnd = stop === -1 ? src.length : stop;
				joined = joined.slice(0, -1) + src.slice(end + 1, nextEnd);
				end = nextEnd;
				// Leading tabs are stripped only for `<<-`; past the delimiter length no join can match.
				const kept = here.stripTabs ? joined.replace(/^\t+/, "") : joined;
				if (kept.length - (kept.endsWith("\\") ? 1 : 0) > limit) break;
				if (
					(here.stripTabs ? joined.replace(/^\t+/, "") : joined) ===
					here.delimiter
				)
					throw new Unreadable();
			}
		}
		if (nl === -1) break;
		at = nl + 1;
	}
	return { bodyEnd: src.length, next: src.length, terminated: false };
}

/**
 * The text of the backtick substitution at `start`, with the escapes bash takes out of it: a
 * backslash before a backtick, a backslash or `$`, and, inside double quotes, before `"`.
 */
export function backtickBody(
	src: string,
	start: number,
	inDouble: boolean,
): { inner: string; end: number } {
	const escapable = inDouble ? '`\\$"' : "`\\$";
	let inner = "";
	let i = start + 1;
	for (; i < src.length && src[i] !== "`"; i++) {
		const next = src[i + 1];
		// Bash joins a backslash and a newline in a backtick body before it reads the body.
		if (src[i] === "\\" && next === "\n") throw new Unreadable();
		if (src[i] === "\\" && next && escapable.includes(next)) i++;
		inner += src[i];
	}
	return { inner, end: Math.min(i + 1, src.length) };
}

/** The redirection operator at `pos` (`>`, `>>`, `<`, `<>`, `>|`, `>&2`, `<&0`) as the word the lexer gives it, where it ends, and whether it closes a descriptor (`>&-`). */
export function redirectOperator(
	src: string,
	pos: number,
): { op: string; end: number; closes: boolean } {
	let op = src[pos] as string;
	let closes = false;
	let end = pos + 1;
	if (src[end] === ">") {
		op += ">";
		end++;
	}
	if (op === "<>") op = ">"; // opens the file for writing too
	if (op === ">" && src[end] === "|") end++; // `>|` forces the overwrite
	if (src[end] === "&") {
		const digit = /\s*[0-9-]/y.test(src.slice(end + 1, end + 65));
		const blank = " \t\n".includes(src[end + 1] ?? "\n");
		// `<& file` names no descriptor; `<& 0` and `<& -` do, as `<&0` does.
		if (op === "<" && blank && !digit) return { op, end, closes };
		end++;
		// `>&2`, `>&-` and `<&0` duplicate or close a descriptor; `>& file` names a file.
		if (op === "<" || digit) op = "dup";
		// `>&-` closes the descriptor: the `-` is its whole operand, and what follows it directly is the next word.
		if (op === "dup" && src[end] === "-") {
			end++;
			closes = true;
		}
	}
	return { op, end, closes };
}
