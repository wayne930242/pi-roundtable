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

/** Forgets every draft. */
export const clearDrafts = (): void => drafts.clear();
