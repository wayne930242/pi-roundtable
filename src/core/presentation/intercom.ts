import type { IntercomCard } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";

/** The most characters of a card's summary line. */
export const INTERCOM_SUMMARY_CHARS = 120;

/**
 * The first line of the text that has words in it, without a Markdown heading's marks, cut to
 * `max` characters with an ellipsis and never through a surrogate pair.
 */
export function intercomSummary(
	text: string,
	max = INTERCOM_SUMMARY_CHARS,
): string {
	const line =
		text
			.split("\n")
			.map((one) => one.trim())
			.find((one) => one !== "") ?? "";
	const plain = line.replace(/^#{1,6}\s+/, "");
	if (plain.length <= max) return plain;
	const last = plain.charCodeAt(max - 2);
	const cut = last >= 0xd800 && last <= 0xdbff ? max - 2 : max - 1;
	return `${plain.slice(0, cut)}…`;
}

/** Whether the summary leaves part of the text out, so the card offers to open to the rest. */
export function intercomFolds(card: IntercomCard): boolean {
	return intercomSummary(card.text) !== card.text.trim();
}

/** The card's heading: whom the request went to, or whom the answer came from. */
export function intercomHeading(card: IntercomCard): string {
	const text = messages();
	const name = card.peer.displayName;
	if (card.kind === "sent") return text.intercomSent(name);
	if (card.kind === "answered") return text.intercomAnswered(name);
	return text.intercomFailed(name);
}

/** The card as plain text, for a surface that shows no cards: its heading, then the whole text. */
export function intercomPlain(card: IntercomCard): string {
	return `${intercomHeading(card)}\n${card.text}`;
}
