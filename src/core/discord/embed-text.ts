import type { Embed } from "discord.js";

/** The most characters the embeds of one message add to its text; the rest is cut and marked. */
export const EMBED_TEXT_CHARS = 4_000;

/** What of an embed is read: its words and link, never its pictures, colors, or timestamp. */
type EmbedFacts = Pick<
	Embed,
	"title" | "description" | "url" | "fields" | "footer" | "author"
>;

const CUT = "…";

function embedLines(embed: EmbedFacts): string[] {
	const lines: string[] = [];
	const head = [embed.author?.name, embed.title].filter(Boolean).join(" — ");
	if (head) lines.push(head);
	if (embed.description) lines.push(embed.description);
	for (const field of embed.fields) lines.push(`${field.name}: ${field.value}`);
	if (embed.footer?.text) lines.push(embed.footer.text);
	if (embed.url) lines.push(embed.url);
	return lines;
}

/**
 * The words of a message's embeds as plain text, one block per embed (title, description, each
 * field as `name: value`, footer, link), so a post that is only an embed, such as an alert a
 * webhook posts, reads as text. Discord renders a Slack-compatible webhook's attachments as
 * embeds, so those are covered too. Text only, nothing is wrapped in markup; at most
 * `EMBED_TEXT_CHARS` characters; empty for a message without embeds.
 */
export function embedText(embeds: readonly EmbedFacts[]): string {
	const text = embeds
		.map((embed) => embedLines(embed).join("\n").replace(/\r\n?/g, "\n").trim())
		.filter(Boolean)
		.join("\n\n");
	return text.length > EMBED_TEXT_CHARS
		? `${text.slice(0, EMBED_TEXT_CHARS - CUT.length)}${CUT}`
		: text;
}

/** A message's own text and its embeds' text, apart by a blank line; either may be empty. */
export function withEmbeds(content: string, embeds: readonly EmbedFacts[]) {
	return [content.trim(), embedText(embeds)].filter(Boolean).join("\n\n");
}
