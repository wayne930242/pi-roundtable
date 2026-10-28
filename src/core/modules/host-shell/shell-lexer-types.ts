/** The words, marks and records the shell lexer shares with the hold rule. */

/** Words that can start a command line before the command itself: `then sudo ls` runs `sudo`. */
export const COMMAND_PREFIX_WORDS: ReadonlySet<string> = new Set([
	"if",
	"then",
	"elif",
	"else",
	"do",
	"while",
	"until",
	"!",
	"coproc",
	"function",
]);

/** Words that can come before `case` or `esac` in a command that is still at its start. */
export const KEYWORDS_BEFORE_CASE: ReadonlySet<string> = new Set([
	...COMMAND_PREFIX_WORDS,
	"time",
]);

/**
 * Follows the `$(` or backtick a word keeps in place of a substitution that the shell running the
 * line expands, so a `bash -c` script holding it is built at run time; a `$(` that came from single
 * quotes or an escape has no mark, and the inner shell is the one that runs it.
 */
export const EXPANDED = "\uE000";

/** The commands of a line, or `unreadable` when the lexer could not tell what bash would run. */
export interface Lexed {
	commands: string[][];
	unreadable: boolean;
	/** Whether the line evaluates arithmetic (`(( ))`, `$(( ))`, `$[ ]`), which runs a `$(` held in a variable's value. */
	arithmetic: boolean;
	/** Whether a `$(` or a backtick stands as text where no shell expands it (single quotes, an escape), which a value can carry into arithmetic. */
	literalSubstitution: boolean;
}

/** A here-document waiting for the end of its line. */
export interface Pending {
	owner: number;
	delimiter: string;
	quoted: boolean;
	stripTabs: boolean;
}

/** What every lexer of one line shares: how deep the substitutions go, and what the line turned out to hold. */
export interface Shared {
	depth: number;
	arithmetic: boolean;
	literalSubstitution: boolean;
}
