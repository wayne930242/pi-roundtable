import { DISCORD_LIMITS, type DiscordCard } from "./poster.ts";
import {
	cardRows,
	checkCardTextSize,
	checkPicture,
} from "./poster-card-parts.ts";
import { invalid } from "./poster-errors.ts";

/** A `preview` flattened to one line: every run of whitespace, line breaks included, becomes one space. */
export function flatPreview(preview: string): string {
	return preview.replace(/\s+/g, " ").trim();
}

/**
 * The body of a card with a `preview`: a legacy message whose `content` is the preview line (what
 * the push notification shows), with one embed for the card's text and picture and ordinary action
 * rows for its buttons and menus. No Components V2 flag, so Discord takes `content` and `embeds`.
 * `components` is always sent, empty when the card has none, so an edit that drops the buttons
 * removes them. The text guard is the V2 card's, and no mention in it pings.
 */
export function legacyCardBody(card: DiscordCard & { preview: string }) {
	const content = flatPreview(card.preview);
	if (content === "")
		throw invalid("a card's preview has text in it (or leave it out)");
	if (content.length > DISCORD_LIMITS.contentChars)
		throw invalid(
			`a card's preview is at most ${DISCORD_LIMITS.contentChars} characters`,
		);
	const sections = card.sections.filter((section) => section !== "");
	checkCardTextSize([
		card.title,
		...sections,
		...(card.footer ? [card.footer] : []),
	]);
	if ([...card.title].length > DISCORD_LIMITS.embedTitleChars)
		throw invalid(
			`a card with a preview has a title of at most ${DISCORD_LIMITS.embedTitleChars} characters`,
		);
	const thumbnail = card.thumbnail
		? checkPicture("a card's thumbnail", card.thumbnail)
		: undefined;
	const image = card.image
		? checkPicture("a card's image", card.image)
		: undefined;
	const components = cardRows(card);
	if (components.length > DISCORD_LIMITS.actionRows)
		throw invalid(
			`a card with a preview holds at most ${DISCORD_LIMITS.actionRows} rows: one for each menu and one for the buttons`,
		);
	return {
		content,
		embeds: [
			{
				title: card.title,
				...(sections.length > 0 ? { description: sections.join("\n\n") } : {}),
				...(card.accent === undefined ? {} : { color: card.accent }),
				...(card.footer ? { footer: { text: card.footer } } : {}),
				...(thumbnail ? { thumbnail: { url: thumbnail.media.url } } : {}),
				...(image ? { image: { url: image.media.url } } : {}),
			},
		],
		components,
		allowed_mentions: { parse: [] as never[] },
	};
}
