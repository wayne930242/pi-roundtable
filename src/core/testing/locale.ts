import { type Locale, setLocale } from "../i18n/index.ts";
import { setTimeZone } from "../time.ts";

/** What a test file runs under; the core's own suite uses the neutral defaults. */
export interface TestLocale {
	locale?: Locale;
	/** An IANA time zone. */
	timeZone?: string;
	/** The assistant's display name in catalog text. */
	assistant?: string;
	/** The root slash command's name, without the slash. */
	root?: string;
}

/**
 * Puts the process under a locale and time zone, UTC and English with neutral names unless given.
 * Call it with nothing to hand back the neutral defaults a test that changed them found. It takes
 * a defaulted object so a hook can receive it without waiting for a callback.
 */
export function useTestLocale(options: TestLocale = {}): void {
	setTimeZone(options.timeZone ?? "UTC");
	setLocale(options.locale ?? "en", {
		assistant: options.assistant ?? "Roundtable",
		root: options.root ?? "roundtable",
	});
}
