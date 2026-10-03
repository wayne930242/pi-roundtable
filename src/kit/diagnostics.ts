/*
 * A pattern whose first characters can recur inside the run it then scans (a leading `\b` before a
 * repeatable class, or a literal such as `eyJ` that may appear again after a `-`) restarts at every
 * repeat and takes quadratic time. Those patterns start at the beginning of a run of their own
 * character class through a lookbehind; the others begin with a literal that cannot recur inside
 * what they scan. Scrubbing then takes time linear in the text at any length.
 */

/** Tool text that may name a credential: userinfo in URLs, bearer values, and well-known token shapes. */
const CREDENTIALS: [RegExp, string | ((...match: string[]) => string)][] = [
	[/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
	[
		/\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi,
		"$1: [redacted]",
	],
	[
		/\b(bearer|basic|token)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
		(match, scheme = "", _space = "", value = "") =>
			looksLikeCredential(value) ? `${scheme} [redacted]` : match,
	],
	[
		/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
		"[redacted]",
	],
	[
		/\b(cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:\s*[^\r\n]+/gi,
		"$1: [redacted]",
	],
	[
		/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
		"[redacted]",
	],
	[
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
		"[redacted]",
	],
];

/** A bare word such as "authentication" is not a credential; a value with digits, symbols or inner capitals, or a very long one, may be. */
function looksLikeCredential(value: string): boolean {
	return (
		/[0-9+/=_~]/.test(value) || /[a-z][A-Z]/.test(value) || value.length >= 32
	);
}

/** Names that say the value is a secret. A plural `tokens` counts tokens, and is not one. */
const SECRET_NAME =
	/token(?!s(?![a-z]))|secret|password|passwd|api[_-]?key|credential/i;
/** What a name may continue with after the keyword and still hold a setting, not a secret. */
const SETTING_SUFFIX =
	/^[_-]?(?:policy|policies|rules?|length|count|limit|max|min|type|format|expir\w*|ttl|lifetime|required|enabled|strategy|file|path|url|name|field|prompt|hint|window|budget|usage)(?![a-z])/i;

/** Whether the name says its value is a secret; a count is not a token, so a token name needs a non-numeric value. */
function secretKind(name: string): "secret" | "token" | undefined {
	const keyword = SECRET_NAME.exec(name);
	if (!keyword) return undefined;
	const rest = name.slice(keyword.index + keyword[0].length);
	if (SETTING_SUFFIX.test(rest)) return undefined;
	return /^token/i.test(keyword[0]) ? "token" : "secret";
}

/** The name and separator of an assignment, query parameter or JSON field; the value is read separately. */
const ASSIGNMENT = /(?<![a-z0-9_-])([a-z0-9_-]+)(["']?\s*[:=]\s*["']?)/gi;
/** An unquoted value ends at a blank, a quote, a separator or a closing bracket. */
const UNQUOTED = /[^\s"',&;}\]]+/y;
/** A quoted value runs to its closing quote, whatever it holds. */
const DOUBLE_QUOTED = /[^"]+/y;
const SINGLE_QUOTED = /[^']+/y;

/** The value that follows a separator ending in `end`, or undefined when there is none. */
function valueAt(
	text: string,
	end: number,
	separator: string,
): string | undefined {
	const quote = separator.endsWith('"')
		? DOUBLE_QUOTED
		: separator.endsWith("'")
			? SINGLE_QUOTED
			: UNQUOTED;
	quote.lastIndex = end;
	return quote.exec(text)?.[0];
}

/** Masks the value of every assignment whose name says it is a secret, in any case. */
function maskAssignments(text: string): string {
	let out = "";
	let cursor = 0;
	for (const match of text.matchAll(ASSIGNMENT)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (start < cursor) continue;
		// The value is read only for a secret name, so ordinary text costs nothing more to pass.
		const kind = secretKind(match[1] ?? "");
		if (!kind) continue;
		const value = valueAt(text, end, match[2] ?? "");
		// An earlier rule already masked this value.
		if (value === undefined || value.startsWith("[redacted")) continue;
		if (kind === "token" && /^[0-9]+$/.test(value)) continue;
		out += `${text.slice(cursor, end)}[redacted]`;
		cursor = end + value.length;
	}
	return out + text.slice(cursor);
}

/**
 * Text from a failed subprocess or worker, safe to show a model or the owner: credentials are
 * masked, control characters are removed, and the length is bounded. Empty input returns "".
 */
export function scrubDiagnostic(text: string, max = 600): string {
	// Only what could survive the final cut is scrubbed, so the work follows the bound asked for.
	let clean = text.slice(0, Math.max(max * 4, 4096));
	for (const [pattern, replacement] of CREDENTIALS)
		clean = clean.replace(pattern, replacement as string);
	clean = maskAssignments(clean);
	clean = Array.from(clean, (char) => {
		const code = char.charCodeAt(0);
		// Keep tab and newline; every other control character becomes a space.
		return code === 9 || code === 10 || code > 31
			? code === 127
				? " "
				: char
			: " ";
	})
		.join("")
		.trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
