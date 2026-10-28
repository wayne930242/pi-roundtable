/**
 * How well `query` matches `text`: its letters must appear in order. Matches that start a word
 * or follow each other score higher; undefined when the letters do not all appear.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
	const needle = query.toLowerCase().replace(/\s+/g, "");
	if (needle === "") return 0;
	const haystack = text.toLowerCase();
	let score = 0;
	let at = 0;
	let streak = 0;
	for (const char of needle) {
		const found = haystack.indexOf(char, at);
		if (found < 0) return undefined;
		const startsWord =
			found === 0 || /[\s\-_./:]/.test(haystack[found - 1] ?? "");
		streak = found === at ? streak + 1 : 0;
		score +=
			1 + (startsWord ? 4 : 0) + streak * 2 - Math.min(found - at, 6) * 0.2;
		at = found + 1;
	}
	// A shorter text that holds the letters is the closer match.
	return score - haystack.length * 0.02;
}
