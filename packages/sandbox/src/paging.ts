/** `Buffer.byteLength(JSON.stringify(text))`: how the sealed worker measures text against a budget. */
export function textBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text));
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * One page of `text` from character `offset` (a JavaScript string index), as much as fits
 * `budget` under `measure` (the worker's `textBytes` by default; a host tool whose result the
 * broker wraps passes `toolResultTextBytes` and its `resultBytes`). When more text follows, the
 * page begins with the line `[More: next offset N]` so a cut never removes it; pass N as the
 * next call's offset. Throws on an offset that is not a whole position in the text.
 */
export function pageText(
	text: string,
	offset: number,
	budget: number,
	measure: (text: string) => number = textBytes,
): string {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
		throw new RangeError(
			`offset must be a whole number from 0 to ${text.length}`,
		);
	if (
		offset > 0 &&
		offset < text.length &&
		isHigh(text.charCodeAt(offset - 1)) &&
		isLow(text.charCodeAt(offset))
	)
		throw new RangeError("offset falls inside a character");
	if (offset === text.length)
		return `(No text at offset ${offset}: that is the end of the text.)`;
	const rest = text.slice(offset);
	if (measure(rest) <= budget) return rest;
	const header = (end: number): string => `[More: next offset ${end}]\n`;
	const fits = (end: number): boolean =>
		measure(header(end) + text.slice(offset, end)) <= budget;
	let low = offset;
	let high = text.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) low = middle;
		else high = middle - 1;
	}
	// Never end between the halves of a surrogate pair.
	if (
		low > offset &&
		isHigh(text.charCodeAt(low - 1)) &&
		isLow(text.charCodeAt(low))
	)
		low--;
	if (low === offset)
		throw new Error("the result budget is too small for one character");
	return header(low) + text.slice(offset, low);
}
