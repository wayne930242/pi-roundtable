import type { DiscordCard } from "../discord/poster/poster.ts";
import { DiscordPosterError } from "../discord/poster/poster-errors.ts";
import { flatPreview } from "../discord/poster/poster-legacy-card.ts";
import { cardText } from "./fake-poster-guild.ts";

/**
 * The `content` the fake keeps for a card message: the preview line of a card that has one (as
 * Discord holds it), else the card as plain text for a test to read.
 */
export function cardContent(card: DiscordCard): string {
	return card.preview === undefined
		? cardText(card)
		: flatPreview(card.preview);
}

/**
 * The card a message holds after an edit. A message keeps its kind: an edit with a `preview` of a
 * Components V2 card stays one and drops the preview (as the real poster does), and an edit
 * without one of a preview card is refused.
 */
export function editedCard(held: DiscordCard, edit: DiscordCard): DiscordCard {
	if (held.preview !== undefined && edit.preview === undefined)
		throw new DiscordPosterError(
			"rejected",
			"editing a card failed: the poster cannot change a message's kind, Components V2 or a preview card",
			{ discordCode: 50035, status: 400 },
		);
	if (held.preview === undefined && edit.preview !== undefined) {
		const { preview: _dropped, ...v2 } = edit;
		return v2;
	}
	return edit;
}
