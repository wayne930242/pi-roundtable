/**
 * What the model is told about Discord's rendering, as the surface's `formatting`. English: it is
 * model-facing text, not a message-catalog string.
 */
export const DISCORD_FORMATTING =
	"Reply formatting (Discord): Markdown renders, except tables, which show as raw | pipes, so use bullet lists or `key: value` lines instead of tables. Headings, bold, italics, lists, quotes, inline code, fenced code blocks and -# small text all work. A reply over 2,000 characters is split into several messages, so keep answers compact.";

/** The guidance a surface option picks: the built-in when absent, none for `false`, else the override. */
export function pickFormatting(
	option: string | false | undefined,
	builtin: string,
): string | undefined {
	if (option === false) return undefined;
	if (option === undefined) return builtin;
	if (option.trim() === "")
		throw new Error(
			"formatting is empty; write the guidance, or false to give the model none",
		);
	return option;
}
