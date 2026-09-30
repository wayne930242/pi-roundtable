import { setLocale } from "../i18n/index.ts";
import { setTimeZone } from "../time.ts";

/** The neutral defaults the core's suite runs under; a test that changes them puts them back with this. */
export function useTestLocale(): void {
	setTimeZone("UTC");
	setLocale("en", { assistant: "Roundtable", root: "roundtable" });
}
