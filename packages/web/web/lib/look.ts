import type { CharacterLook } from "pi-roundtable/characters";
import { signal } from "./signal.ts";
import { paintThemeColor, useTheme } from "./theme.ts";

/** The page's look: the plain `modern` one, or the fantasy `camelot` one. */
export type PageLook = "modern" | "camelot";

const KEY = "rt-look";
export const LOOKS: readonly PageLook[] = ["modern", "camelot"];

const { emit, use } = signal();
/** What the host chose; a device's own pick wins over it. */
let fallback: PageLook = "modern";
let stored: PageLook | undefined = read();
let current: PageLook = stored ?? fallback;

function read(): PageLook | undefined {
	try {
		const value = localStorage.getItem(KEY);
		return LOOKS.find((look) => look === value);
	} catch {
		// Storage can be off (private mode); the host's look then decides.
		return undefined;
	}
}

function apply(): void {
	current = stored ?? fallback;
	// `data-look` is what the stylesheets read; the Camelot theme keys on it.
	document.documentElement.dataset.look = current;
	paintThemeColor();
	emit();
}

/** Puts the look on the page: the device's own pick if it has one, else the host's. Called once the config is in. */
export function initLook(hostLook: PageLook | undefined): void {
	fallback = hostLook === "camelot" ? "camelot" : "modern";
	stored = read();
	apply();
}

/** Picks a look for this device; `undefined` goes back to the host's. */
export function setLook(next: PageLook | undefined): void {
	stored = next;
	try {
		if (next) localStorage.setItem(KEY, next);
		else localStorage.removeItem(KEY);
	} catch {
		// The choice then lasts until the page closes.
	}
	apply();
}

/** The look the page shows now. */
export function useLook(): PageLook {
	return use(() => current);
}

/** The character look for a page look and a color scheme. */
export const characterLookOf = (
	look: PageLook,
	scheme: "light" | "dark",
): CharacterLook => `${look}-${scheme}`;

/** The frame a look puts around characters: Camelot's heraldic shield, a disc otherwise. */
export const frameOf = (look: PageLook): "disc" | "shield" =>
	look === "camelot" ? "shield" : "disc";

/** What a character needs to draw itself on this page, from the look and the scheme. */
export function useCharacterStyle(): {
	look: CharacterLook;
	frame: "disc" | "shield";
	scheme: "light" | "dark";
} {
	const look = useLook();
	const { resolved } = useTheme();
	return {
		look: characterLookOf(look, resolved),
		frame: frameOf(look),
		scheme: resolved,
	};
}
