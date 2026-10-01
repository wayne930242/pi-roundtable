import { messages, setLocale } from "../i18n/index.ts";
import { setTimeZone } from "../time.ts";

const EAGER = "EAGER:";

/**
 * Puts the process under a catalog whose every text carries a mark and a foreign time zone, so a
 * value built before the host applied its environment can be recognised with `eagerText`;
 * `useTestLocale()` gives the neutral defaults back.
 */
export function useEagerCatalog(): void {
	setTimeZone("America/New_York");
	setLocale("en", { assistant: "Before", root: "before" });
	const marked: Record<string, string> = {};
	for (const [key, value] of Object.entries(messages()))
		if (typeof value === "string") marked[key] = `${EAGER}${key}`;
	setLocale("en", {
		assistant: "Before",
		root: "before",
		overrides: marked as Partial<ReturnType<typeof messages>>,
	});
}

/** Every marked string under the value; functions are not called, so lazy text stays hidden. */
export function eagerText(value: unknown, seen = new Set<unknown>()): string[] {
	if (typeof value === "string") return value.startsWith(EAGER) ? [value] : [];
	if (typeof value !== "object" || value === null || seen.has(value)) return [];
	seen.add(value);
	return Object.values(value).flatMap((child) => eagerText(child, seen));
}
