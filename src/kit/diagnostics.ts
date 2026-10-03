/** Tool text that may name a credential: userinfo in URLs, bearer values, and well-known token shapes. */
const CREDENTIALS: [RegExp, string][] = [
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
	[
		/\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi,
		"$1: [redacted]",
	],
	[/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
	[
		/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
		"[redacted]",
	],
	[
		/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/g,
		"$1=[redacted]",
	],
	[
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
		"[redacted]",
	],
];

/**
 * Text from a failed subprocess or worker, safe to show a model or the owner: credentials are
 * masked, control characters are removed, and the length is bounded. Empty input returns "".
 */
export function scrubDiagnostic(text: string, max = 600): string {
	let clean = text;
	for (const [pattern, replacement] of CREDENTIALS)
		clean = clean.replace(pattern, replacement);
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
