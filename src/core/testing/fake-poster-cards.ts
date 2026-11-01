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
 * Refuses an edit that changes a message's kind: a Components V2 message cannot be edited into a
 * `preview` (legacy) card, and a legacy message cannot become a Components V2 card.
 */
export function assertSameCardKind(held: DiscordCard, edit: DiscordCard): void {
	if ((held.preview !== undefined) !== (edit.preview !== undefined))
		throw new DiscordPosterError(
			"rejected",
			"editing a card failed: a message keeps its kind, Components V2 or a preview card",
			{ discordCode: 50035, status: 400 },
		);
}
