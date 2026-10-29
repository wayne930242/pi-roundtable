import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The English source strings the console's code asks to have translated, read from its source text:
 * the keys a host's `presentation.messages` (or the built-in catalog) must cover.
 */

const PACKAGE = join(import.meta.dir, "..", "..");

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "testing" || entry.name === "node_modules"
				? []
				: sourceFiles(path);
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
			? [path]
			: [];
	});

/** The position just past a string literal that starts at `at`, and its text; a template with a substitution is not a literal. */
function literalAt(
	source: string,
	at: number,
): { text: string; end: number } | undefined {
	const quote = source[at];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
	let text = "";
	for (let i = at + 1; i < source.length; i++) {
		const char = source[i] as string;
		if (char === "\\") {
			const next = source[i + 1] as string;
			text += { n: "\n", t: "\t" }[next] ?? next;
			i++;
		} else if (char === quote) return { text, end: i + 1 };
		else if (quote === "`" && char === "$" && source[i + 1] === "{")
			return undefined;
		else text += char;
	}
	return undefined;
}

const skipSpace = (source: string, at: number): number => {
	let i = at;
	while (i < source.length && /\s/.test(source[i] as string)) i++;
	// A comment between arguments is not a source string either.
	return i;
};

/** One argument of a call starting at `at`: its literal text when it is one, else its source; and where the next argument starts. */
function argumentAt(
	source: string,
	at: number,
): { literal?: string; raw: string; next: number; last: boolean } {
	const start = skipSpace(source, at);
	const literal = literalAt(source, start);
	if (literal) {
		const after = skipSpace(source, literal.end);
		if (source[after] === "," || source[after] === ")")
			return {
				literal: literal.text,
				raw: source.slice(start, literal.end),
				next: after + 1,
				last: source[after] === ")",
			};
	}
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const char = source[i] as string;
		if (char === '"' || char === "'" || char === "`") {
			i = scanString(source, i);
		} else if ("([{".includes(char)) depth++;
		else if (")]}".includes(char)) {
			if (depth === 0)
				return {
					raw: source.slice(start, i).trim(),
					next: i + 1,
					last: true,
				};
			depth--;
		} else if (char === "," && depth === 0)
			return { raw: source.slice(start, i).trim(), next: i + 1, last: false };
	}
	return { raw: source.slice(start).trim(), next: source.length, last: true };
}

/** The index of the closing quote of the string (or template) that opens at `at`. */
function scanString(source: string, at: number): number {
	const quote = source[at];
	for (let i = at + 1; i < source.length; i++) {
		const char = source[i];
		if (char === "\\") i++;
		else if (char === quote) return i;
		else if (quote === "`" && char === "$" && source[i + 1] === "{") {
			let depth = 1;
			i += 2;
			while (i < source.length && depth > 0) {
				if (source[i] === "{") depth++;
				else if (source[i] === "}") depth--;
				i++;
			}
			i--;
		}
	}
	return source.length;
}

/** The arguments of every call of `names` in a source text; `index` picks which arguments are source strings. */
function calls(
	source: string,
	names: readonly string[],
): { name: string; args: ReturnType<typeof argumentAt>[] }[] {
	const found: { name: string; args: ReturnType<typeof argumentAt>[] }[] = [];
	const pattern = new RegExp(`(?<![\\w.$])(${names.join("|")})\\(`, "g");
	for (const match of source.matchAll(pattern)) {
		const args: ReturnType<typeof argumentAt>[] = [];
		let at = match.index + match[0].length;
		for (;;) {
			const arg = argumentAt(source, at);
			args.push(arg);
			if (arg.last) break;
			at = arg.next;
		}
		found.push({ name: match[1] as string, args });
	}
	return found;
}

export interface SourceMessages {
	/** Keys the browser app asks for, with the file that does. */
	client: Map<string, string>;
	/** Keys the server's API and login page answer with. */
	server: Map<string, string>;
	/** Translation calls whose key is not a literal, as `file: expression`; each must read from a table of `wording(...)` marks. */
	dynamic: string[];
}

/** The calls, in the browser app, that ask for a translation. */
export function clientMessages(): Pick<SourceMessages, "client" | "dynamic"> {
	const client = new Map<string, string>();
	const dynamic: string[] = [];
	const webDir = join(PACKAGE, "web");
	for (const file of sourceFiles(webDir)) {
		const name = relative(PACKAGE, file);
		// The table scene words nothing itself; its labels come in from the page. Its `translate(` is SVG's.
		if (name.endsWith("lib/messages.ts") || name.startsWith("web/table/"))
			continue;
		const source = readFileSync(file, "utf8");
		for (const call of calls(source, ["t", "translate", "wording", "plural"])) {
			// `plural(count, one, many)` words two messages after the count.
			const sources =
				call.name === "plural" ? call.args.slice(1, 3) : [call.args[0]];
			for (const arg of sources) {
				if (!arg) continue;
				if (arg.literal !== undefined) client.set(arg.literal, name);
				else dynamic.push(`${name}: ${call.name}(${arg.raw})`);
			}
		}
	}
	return { client, dynamic };
}

/** The literal wording the server puts in its refusals and on its login page. */
export function serverMessages(): Map<string, string> {
	const server = new Map<string, string>();
	const srcDir = join(PACKAGE, "src");
	for (const file of sourceFiles(srcDir)) {
		const name = relative(PACKAGE, file);
		// Configuration errors the host's developer reads, and the catalog itself.
		if (name.startsWith("src/i18n/") || name === "src/visitors.ts") continue;
		const source = readFileSync(file, "utf8");
		for (const call of calls(source, [
			"HttpError",
			"LayoutRefusal",
			"UploadRefusal",
			"bad",
			"message",
			"say",
		])) {
			// The message is the second argument of an error built with a status, the first of `bad` and `say`.
			const index = ["bad", "say"].includes(call.name) ? 0 : 1;
			const arg = call.args[index];
			if (arg?.literal !== undefined && /[A-Za-z]/.test(arg.literal))
				server.set(arg.literal, name);
		}
		for (const match of source.matchAll(/\brefusal:\s*(?=["'`])/g)) {
			const literal = literalAt(source, match.index + match[0].length);
			if (literal) server.set(literal.text, name);
		}
	}
	// The memory refusals the Notes pane words, which `console-api.ts` keeps in a table.
	const api = readFileSync(join(srcDir, "console-api.ts"), "utf8");
	const table = /MEMORY_REASONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(api)?.[1] ?? "";
	for (const match of table.matchAll(/:\s*(?=["'`])/g)) {
		const literal = literalAt(table, match.index + match[0].length);
		if (literal) server.set(literal.text, "src/console-api.ts");
	}
	return server;
}
