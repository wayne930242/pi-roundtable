import { createEn, type Messages } from "./en.ts";
import type { CatalogContext } from "./types.ts";
import { createZhTW } from "./zh-tw.ts";

export type { CatalogContext } from "./types.ts";

export type { Messages };

export type Locale = "en" | "zh-TW";

export const LOCALES: readonly Locale[] = ["en", "zh-TW"];

export function isLocale(value: unknown): value is Locale {
	return LOCALES.some((locale) => locale === value);
}

export interface LocaleSettings extends CatalogContext {
	/** Entries that replace the locale's own, such as one operator's wording of a card. */
	overrides?: Partial<Messages>;
}

const DEFAULTS: CatalogContext = {
	assistant: "Roundtable",
	root: "roundtable",
};

function build(locale: Locale, settings: LocaleSettings): Messages {
	const ctx: CatalogContext = {
		assistant: settings.assistant,
		root: settings.root,
	};
	const catalog = locale === "zh-TW" ? createZhTW(ctx) : createEn(ctx);
	return { ...catalog, ...settings.overrides };
}

let active: Messages = build("en", DEFAULTS);
let names: CatalogContext = DEFAULTS;

/**
 * Chooses the catalog of Discord text for the whole process; the host calls it once at startup,
 * before anything shows text. `assistant` is the assistant's display name and `root` the name of
 * its root slash command, without the slash.
 */
export function setLocale(locale: Locale, settings: LocaleSettings): void {
	if (!isLocale(locale)) throw new Error(`Unknown locale: ${String(locale)}`);
	active = build(locale, settings);
	names = { assistant: settings.assistant, root: settings.root };
}

/** The active catalog. Read it when the text is shown, never at import time. */
export function messages(): Messages {
	return active;
}

/** The assistant's display name, for text that is not part of a catalog, such as a tool description. */
export function assistantName(): string {
	return names.assistant;
}
