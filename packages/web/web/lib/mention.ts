// The `@AI` a person types at the start of a message to address the agent. It is the page's own
// shorthand for the toggle: the page turns it into an explicit `mode: "turn"`, and the server never
// reads a message's text for it, so text that came from anywhere else (a customer, an agent, a
// quote, a paste) cannot start a turn.

/** The token as the first word of the text: followed by whitespace, a colon, a comma or the end. */
const LEADING = /^\s*@ai(?=\s|[:,：，]|$)/i;

/** The token with the space, colon or comma after it. */
const LEADING_WITH_PUNCTUATION = /^\s*@ai\s*[:,：，]?\s*/i;

/** Whether the text starts with `@AI` as a word of its own. */
export function hasLeadingAiMention(text: string): boolean {
	return LEADING.test(text);
}

/** The text without a leading `@AI` and the space, colon or comma after it; a mention elsewhere stays. */
export function withoutLeadingAiMention(text: string): string {
	return LEADING.test(text) ? text.replace(LEADING_WITH_PUNCTUATION, "") : text;
}
