import { LineError } from "./errors.ts";

/**
 * The name and icon a push is shown under, in place of the channel's own. LINE shows the name as
 * "<name> from '<channel>'". Either part may be given; a push with none uses the channel's.
 */
export interface LineSender {
	/** 1 to 20 characters, none of the forbidden words. */
	name?: string;
	/** An `https` URL of at most 2000 characters that LINE can fetch. */
	iconUrl?: string;
}

export interface SenderOptions {
	/**
	 * Words a sender name may not contain, compared without regard to case or width and only as whole words
	 * (a word is a run of Latin letters and digits, or a run of letters of another script, so "LINE"
	 * next to kana or hanzi is still the word). Default `["LINE", "LY"]`, the words LINE refuses.
	 */
	forbiddenWords: readonly string[];
}

export const SENDER_DEFAULTS: SenderOptions = Object.freeze({
	forbiddenWords: Object.freeze(["LINE", "LY"]),
});

export const SENDER_NAME_MAX = 20;
export const SENDER_ICON_MAX = 2000;

const bad = (message: string): LineError =>
	new LineError("bad_sender", `line: ${message}`);

/** Refuses a mistake in the sender options, naming the field. */
export function checkSenderOptions(options: Partial<SenderOptions>): void {
	for (const key of Object.keys(options))
		if (key !== "forbiddenWords")
			throw new Error(`line: sender.${key} is not a sender option`);
	const words = options.forbiddenWords;
	if (words === undefined) return;
	if (
		!Array.isArray(words) ||
		words.some((w) => typeof w !== "string" || w.trim() === "")
	)
		throw new Error(
			"line: sender.forbiddenWords must be a list of non-empty words",
		);
}

// A word is a run of Latin letters and digits, or a run of letters of another script: a boundary
// between the two breaks a word, so a name like "LINE" followed by kana still holds the word.
const WORD =
	/(?:\p{Script=Latin}|\p{M}|\p{N})+|(?:(?!\p{Script=Latin})\p{L})+/gu;

/** Why LINE would refuse a sender name. */
export type SenderNameProblem =
	| "empty"
	| "edge_space"
	| "control_character"
	| "too_long"
	| "forbidden_word";

/**
 * Why LINE would refuse `name` as a sender name, or undefined when it would take it. The first
 * problem found is the one returned, checked in the order `empty`, `edge_space`,
 * `too_long`, `control_character`, `forbidden_word`. `control_character` covers C0, DEL and C1
 * (U+0080 to U+009F). Never throws: a value that is not a string is `empty`.
 */
export function senderNameProblem(
	name: string,
	options: SenderOptions = SENDER_DEFAULTS,
): SenderNameProblem | undefined {
	if (typeof name !== "string" || name.trim() === "") return "empty";
	if (name !== name.trim()) return "edge_space";
	if (Array.from(name).length > SENDER_NAME_MAX) return "too_long";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
	if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "control_character";
	// Full-width letters are the letters they look like.
	const words = (name.normalize("NFKC").match(WORD) ?? []).map((w) =>
		w.toLowerCase(),
	);
	// An options object without the list (a cast, or untyped JavaScript) means the default list.
	const forbidden = (
		Array.isArray(options?.forbiddenWords)
			? options.forbiddenWords
			: SENDER_DEFAULTS.forbiddenWords
	).map((w) => w.normalize("NFKC").toLowerCase());
	return words.some((w) => forbidden.includes(w))
		? "forbidden_word"
		: undefined;
}

const NAME_PROBLEM_TEXT: Record<SenderNameProblem, string> = {
	empty: "a sender name is a non-empty string",
	edge_space: "a sender name has no leading or trailing space",
	too_long: `a sender name is at most ${SENDER_NAME_MAX} characters`,
	control_character: "a sender name has no control characters",
	forbidden_word: "a sender name may not use a word LINE refuses",
};

/**
 * Checks a sender before anything is queued and returns it as it will be sent. Throws `LineError`
 * `bad_sender` for a name that is empty, over 20 characters, holds a control character or a
 * forbidden word, or an icon that is not an `https` URL of at most 2000 characters; the message
 * names the rule, never the value.
 */
export function validateSender(
	sender: LineSender | undefined,
	options: SenderOptions = SENDER_DEFAULTS,
): LineSender | undefined {
	if (sender === undefined) return undefined;
	if (typeof sender !== "object" || sender === null || Array.isArray(sender))
		throw bad("a sender is { name, iconUrl }");
	const { name, iconUrl, ...rest } = sender as Record<string, unknown>;
	if (Object.keys(rest).length > 0)
		throw bad("a sender has a name and an iconUrl, nothing else");
	if (name === undefined && iconUrl === undefined)
		throw bad("a sender needs a name or an iconUrl");
	const checked: LineSender = {};
	if (name !== undefined) {
		const problem = senderNameProblem(name as string, options);
		if (problem) throw bad(NAME_PROBLEM_TEXT[problem]);
		checked.name = name as string;
	}
	if (iconUrl !== undefined) {
		if (typeof iconUrl !== "string" || iconUrl.length > SENDER_ICON_MAX)
			throw bad(
				`a sender iconUrl is a string of at most ${SENDER_ICON_MAX} characters`,
			);
		let url: URL;
		try {
			url = new URL(iconUrl);
		} catch {
			throw bad("a sender iconUrl is a URL");
		}
		if (url.protocol !== "https:" || url.hostname === "" || url.username)
			throw bad("a sender iconUrl is an https URL without credentials");
		checked.iconUrl = iconUrl;
	}
	return checked;
}
