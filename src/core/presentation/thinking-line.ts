import { DISCORD_MESSAGE_LIMIT } from "./reply-splitter.ts";

/** Kept well inside the message limit, since every line also carries the `-#` prefix. */
export const THINKING_LIMIT = 1_200;

/**
 * The assistant's thinking as one quiet Discord message: small grey text, blank lines dropped so the
 * subheading style holds, and cut with an ellipsis when it runs long.
 */
export function thinkingLine(thinking: string): string | undefined {
	const text = thinking.trim();
	if (!text) return undefined;
	const cut =
		text.length > THINKING_LIMIT ? `${text.slice(0, THINKING_LIMIT)}…` : text;
	const message = cut
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => `-# ${line}`)
		.join("\n");
	return message.length > DISCORD_MESSAGE_LIMIT
		? message.slice(0, DISCORD_MESSAGE_LIMIT - 1)
		: message;
}
