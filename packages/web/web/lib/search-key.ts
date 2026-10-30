import { composingKey } from "./ime.ts";

/** Ctrl+K or ⌘K, which opens the room search from anywhere, a text field included; not while an input method composes. */
export const isSearchKey = (event: KeyboardEvent): boolean =>
	(event.metaKey || event.ctrlKey) &&
	event.key.toLowerCase() === "k" &&
	!composingKey(event);
