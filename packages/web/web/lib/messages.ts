import type { ConfigView } from "../../src/api-types.ts";
import { isTraditionalChineseTaiwan } from "../../src/i18n/locale.ts";

/** The authenticated HTML includes inert wording so even an expired first API call is localized. */
function bootstrap(): Pick<ConfigView, "locale" | "messages"> {
	if (typeof document === "undefined") return {};
	const content = document.querySelector<HTMLMetaElement>(
		'meta[name="roundtable-console-presentation"]',
	)?.content;
	try {
		return content ? (JSON.parse(content) ?? {}) : {};
	} catch {
		return {};
	}
}
let presentation: Pick<ConfigView, "locale" | "messages"> = bootstrap();
export function setPresentation(config: ConfigView): void {
	presentation = config;
}

/** The built-in wording for the locale, once `loadBuiltInMessages` has fetched it. */
let builtIn: Readonly<Record<string, string>> | undefined;
let builtInLocale: string | undefined;

/**
 * Fetches the built-in catalog the locale asks for, so the page can draw in it. Each catalog is a
 * chunk of its own: a page in English, or in a host's own wording, never downloads one.
 */
export async function loadBuiltInMessages(
	locale: string | undefined,
): Promise<void> {
	if (builtInLocale === locale) return;
	builtIn =
		locale !== undefined && isTraditionalChineseTaiwan(locale)
			? (await import("../../src/i18n/zh-tw.ts")).ZH_TW
			: undefined;
	builtInLocale = locale;
}

/** The locale the page's bootstrap data names, before the config arrives. */
export const bootstrapLocale = (): string | undefined => bootstrap().locale;
export function translate(
	source: string,
	values: Record<string, string | number> = {},
): string {
	return (
		presentation.messages?.[source] ??
		builtIn?.[source] ??
		source
	).replace(/\{(\w+)\}/g, (token, name: string) =>
		String(values[name] ?? token),
	);
}
/** `one` for a count of 1 and `many` otherwise, each its own message so a host can word both; both may use `{count}`. */
export function plural(count: number, one: string, many: string): string {
	return translate(count === 1 ? one : many, { count });
}
export function locale(): string {
	return presentation.locale ?? "en-GB";
}
/** Marks an English source string that is translated later through `translate`, so the catalog test finds it. */
export const wording = <S extends string>(source: S): S => source;
