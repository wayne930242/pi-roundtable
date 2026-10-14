/** How many code points `text` has. */
export function countPoints(text: string): number {
	let points = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i++;
		points++;
	}
	return points;
}

/** The first `count` code points of `text`. */
export function firstPoints(text: string, count: number): string {
	let end = 0;
	for (let points = 0; points < count && end < text.length; points++) {
		const code = text.charCodeAt(end);
		end += code >= 0xd800 && code <= 0xdbff && end + 1 < text.length ? 2 : 1;
	}
	return text.slice(0, end);
}

/** The first `max` characters of `text`, backing off a cut that would split a surrogate pair. */
export function prefix(text: string, max: number): string {
	if (text.length <= max) return text;
	const code = text.charCodeAt(max - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
