// The commands a message box takes when the text is a slash and a name, such as `/clear`. A command
// is not sent as a message: the box empties and the command runs. The list a page hands the
// composer is all it needs for a new command; the menu above the box lists what is not hidden.

interface SlashContext {
	/** The message box, for a command that asks a question and hands the focus back when it is answered. */
	focus(): HTMLElement | null;
}

export interface SlashCommand {
	/** The name without its slash, in lower case. */
	name: string;
	/** Other names that run it, without the slash. */
	aliases?: readonly string[];
	/** One line for the menu. */
	description: string;
	/** Runs when typed in full but is not offered in the menu, such as one that only says it does not apply. */
	hidden?: boolean;
	run(context: SlashContext): void;
}

/** The command that `text` is, whole: a slash and a name, spaces around ignored, case ignored. */
export function commandFor(
	text: string,
	commands: readonly SlashCommand[] | undefined,
): SlashCommand | undefined {
	const typed = text.trim().toLowerCase();
	if (!typed.startsWith("/")) return undefined;
	return commands?.find(
		(one) => `/${one.name}` === typed || one.aliases?.includes(typed.slice(1)),
	);
}

/** What the box holds when it is the start of a command and nothing else: a slash and the letters of a name. */
export const commandQuery = (text: string): string | undefined =>
	/^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : undefined;
