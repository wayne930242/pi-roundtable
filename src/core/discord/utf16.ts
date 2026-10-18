/**
 * `text` cut to at most `max` UTF-16 units, the count discord.js validates, without splitting a
 * surrogate pair; with `ellipsis` the cut ends in `…` inside the limit.
 */
export function clip(text: string, max: number, ellipsis = false): string {
	if (text.length <= max) return text;
	let end = ellipsis ? max - 1 : max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return ellipsis ? `${text.slice(0, end)}…` : text.slice(0, end);
}
