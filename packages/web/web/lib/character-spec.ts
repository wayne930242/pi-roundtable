import type { CharacterSpec } from "pi-roundtable/characters";
import type { Kit } from "./kit.ts";

/** Who a character belongs to, for the suggestion that stands in when the server's spec cannot be used. */
export interface Owner {
	name: string;
	displayName?: string | undefined;
}

/** The same spec arrives again with every refetch; handing back one object keeps memoized drawings. */
const interned = new Map<string, CharacterSpec>();
const INTERNED_MAX = 200;

function intern(spec: CharacterSpec): CharacterSpec {
	const key = JSON.stringify(spec);
	const known = interned.get(key);
	if (known) return known;
	if (interned.size >= INTERNED_MAX) interned.clear();
	interned.set(key, spec);
	return spec;
}

/** What an owner would get from its name alone. */
export const suggestionFor = (kit: Kit, owner: Owner): CharacterSpec =>
	kit.suggestCharacter({
		name: owner.name,
		displayName: owner.displayName ?? owner.name,
		prompt: "",
	});

/**
 * A character from the server, checked: a spec that does not parse is logged and the suggestion for
 * its owner stands in. Everything the page draws has been through here or through `composeSvg`'s own check.
 */
export function receivedCharacter(
	kit: Kit,
	raw: unknown,
	owner: Owner,
): CharacterSpec {
	try {
		return intern(kit.parseCharacter(raw));
	} catch (failure) {
		console.warn(
			`the character of ${owner.name} was refused; drawing a suggestion`,
			failure,
		);
		return intern(suggestionFor(kit, owner));
	}
}
