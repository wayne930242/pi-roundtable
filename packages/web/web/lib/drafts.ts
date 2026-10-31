// What was typed in a room and not sent yet. Switching rooms in place remounts the room's page, so
// the text waits here, per room, until the person comes back or sends it.

const drafts = new Map<string, string>();

/** The unsent text of a room; empty when there is none. */
export const draftOf = (room: string): string => drafts.get(room) ?? "";

/** Keeps a room's unsent text; empty text forgets it. */
export function keepDraft(room: string, text: string): void {
	if (text === "") drafts.delete(room);
	else drafts.set(room, text);
}

const listeners = new Map<string, Set<(text: string) => void>>();

/** Hears of text put into a room's draft from outside the box (a quote); returns the way to stop. */
export function onDraftInserted(
	room: string,
	listener: (text: string) => void,
): () => void {
	const set = listeners.get(room) ?? new Set();
	set.add(listener);
	listeners.set(room, set);
	return () => {
		set.delete(listener);
		if (set.size === 0) listeners.delete(room);
	};
}

/** The text as a Markdown quote: each line after "> ", then a blank line for the reply. */
export const quoted = (text: string): string =>
	`${text
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n")}\n\n`;

/** Puts `text` into a room's draft as a quote below what is there, and tells the box if it is open. */
export function quoteInto(room: string, text: string): void {
	const have = draftOf(room);
	const gap =
		have === "" || have.endsWith("\n\n")
			? ""
			: have.endsWith("\n")
				? "\n"
				: "\n\n";
	const next = `${have}${gap}${quoted(text)}`;
	keepDraft(room, next);
	for (const listener of listeners.get(room) ?? []) listener(next);
}

const mentioners = new Map<string, Set<(name: string) => void>>();

/** Hears of a name to mention in a room's box, which puts it where the caret is; returns the way to stop. */
export function onMentionRequested(
	room: string,
	listener: (name: string) => void,
): () => void {
	const set = mentioners.get(room) ?? new Set();
	set.add(listener);
	mentioners.set(room, set);
	return () => {
		set.delete(listener);
		if (set.size === 0) mentioners.delete(room);
	};
}

/** `text` with `@name ` put in at `from`..`to` (a space before it when a word stands there); the caret's place after it comes with it. */
export function withMention(
	text: string,
	name: string,
	from = text.length,
	to = from,
): { text: string; caret: number } {
	const before = text.slice(0, from);
	const after = text.slice(to);
	const lead = before === "" || /\s$/.test(before) ? "" : " ";
	// A space already after the caret closes the mention, and the caret steps over it.
	const gap = /^\s/.test(after) ? 1 : 0;
	const put = `${lead}@${name}${gap ? "" : " "}`;
	return {
		text: `${before}${put}${after}`,
		caret: from + put.length + gap,
	};
}

/**
 * Asks a room's box to mention `name`: the open box puts it at its caret (at the end when it is not
 * the one being typed in) and takes the focus; without a box the draft takes it at the end.
 */
export function mentionInto(room: string, name: string): void {
	const listening = mentioners.get(room);
	if (listening && listening.size > 0) {
		for (const listener of listening) listener(name);
		return;
	}
	keepDraft(room, withMention(draftOf(room), name).text);
}

/** Forgets every draft. */
export const clearDrafts = (): void => drafts.clear();
