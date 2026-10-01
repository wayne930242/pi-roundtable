import { definePlugin, serviceKey } from "pi-roundtable";

/** What the notes plugin offers other plugins: a port, so any object with these methods will do. */
export interface NoteIndex {
	add(text: string): void;
	all(): readonly string[];
}

/** The key is the service's name. Give its id a prefix of your own; two keys with one id are one service. */
export const NOTE_INDEX = serviceKey<NoteIndex>("my-notes.index");

/** A plugin lists the services it provides, then provides each from `setup`. */
export function notes() {
	const stored: string[] = [];
	return definePlugin({
		name: "my-notes",
		provides: [NOTE_INDEX],
		setup: ({ services }) => {
			services.provide(NOTE_INDEX, {
				add: (text) => void stored.push(text),
				all: () => stored,
			});
			return { services: [{ name: "notes-ready" }] };
		},
	});
}

/** A plugin registered after it reads the service; `find` is undefined when nobody provides it. */
export function noteReader(
	onNotes: (notes: readonly string[] | undefined) => void,
) {
	return definePlugin({
		name: "note-reader",
		setup: ({ services }) => ({
			services: [
				{
					name: "note-reader",
					start: () => onNotes(services.find(NOTE_INDEX)?.all()),
				},
			],
		}),
	});
}

/** A plugin that provides the same key and lists it in `replaces` takes the place of the one before it. */
export function shoutingNotes() {
	const stored: string[] = [];
	return definePlugin({
		name: "shouting-notes",
		provides: [NOTE_INDEX],
		replaces: [NOTE_INDEX],
		setup: ({ services }) => {
			services.provide(NOTE_INDEX, {
				add: (text) => void stored.push(text.toUpperCase()),
				all: () => stored,
			});
			return { services: [{ name: "shouting-notes-ready" }] };
		},
	});
}
