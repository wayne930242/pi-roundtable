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

/** Forgets every draft. */
export const clearDrafts = (): void => drafts.clear();
