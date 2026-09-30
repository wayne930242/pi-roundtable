const MAX_LENGTH = 80;
// The card font has no emoji glyphs, so the card would draw each as a code-point box.
const EMOJI =
	/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu;

function stripMarkdown(line: string): string {
	return line
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<(https?:\/\/[^>]+)>/g, "$1")
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/(\*\*|__|~~|`)/g, "")
		.replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$|[，。！？,.!?])/g, "$1$2")
		.replace(EMOJI, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** The reply's first sentence as plain text without emoji, at most 80 characters. */
export function headline(text: string): string {
	const withoutCode = text.replace(/```[\s\S]*?(```|$)/g, "\n");
	const firstLine = withoutCode
		.split("\n")
		.map(stripMarkdown)
		.find((line) => line.length > 0);
	if (!firstLine) return "";

	const sentence =
		firstLine.match(/^.*?(?:[。！？!?]|\.(?=\s|$))/)?.[0] ?? firstLine;
	const characters = Array.from(sentence.trim());
	return characters.length <= MAX_LENGTH
		? characters.join("")
		: `${characters.slice(0, MAX_LENGTH - 1).join("")}…`;
}
