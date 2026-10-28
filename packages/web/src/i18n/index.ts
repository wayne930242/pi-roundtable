import { isTraditionalChineseTaiwan } from "./locale.ts";
import { ZH_TW } from "./zh-tw.ts";

export { isTraditionalChineseTaiwan };

/** The wording the console ships for a locale, or none: English source strings are the keys, so English needs no catalog. */
export function builtInMessages(
	locale: string | undefined,
): Readonly<Record<string, string>> | undefined {
	return locale !== undefined && isTraditionalChineseTaiwan(locale)
		? ZH_TW
		: undefined;
}
