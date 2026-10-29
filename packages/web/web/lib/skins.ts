import type { Hex } from "pi-roundtable/characters";
import { signal } from "./signal.ts";

const { emit, use } = signal();
const HEX = /^#[0-9a-f]{6}$/;

/**
 * What the host chose; undefined draws with the kit's own skins. This module only imports types:
 * the character kit is a chunk of its own, and the entry must not pull it in.
 */
let current: readonly Hex[] | undefined;

/** Puts the host's skin tones on the page, six `#rrggbb` colors or else the kit's own; called once the config is in. */
export function initSkins(skins: readonly string[] | undefined): void {
	const next =
		skins?.length === 6 && skins.every((hex) => HEX.test(hex))
			? (skins as readonly Hex[])
			: undefined;
	if (next === current) return;
	current = next;
	emit();
}

/** The host's skin tones for a drawing made outside a component; undefined means the kit's own. */
export const skinsNow = (): readonly Hex[] | undefined => current;

/** The host's skin tones, undefined while it chose none; a component draws again when they change. */
export const useSkins = (): readonly Hex[] | undefined => use(() => current);
