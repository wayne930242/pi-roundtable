/** Whether a BCP 47 tag asks for Traditional Chinese as written in Taiwan: `zh-TW`, `zh-Hant-TW`, and `zh-Hant` with no other region. */
export function isTraditionalChineseTaiwan(locale: string): boolean {
	try {
		const tag = new Intl.Locale(locale.replaceAll("_", "-"));
		if (tag.language !== "zh") return false;
		if (tag.script !== undefined && tag.script !== "Hant") return false;
		return tag.region === "TW" || (tag.script === "Hant" && !tag.region);
	} catch {
		return false;
	}
}
