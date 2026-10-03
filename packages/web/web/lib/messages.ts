import type { ConfigView } from "../../src/api-types.ts";
import { message } from "../../src/features.ts";

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
export function translate(
	source: string,
	values: Record<string, string | number> = {},
): string {
	return message(presentation, source).replace(
		/\{(\w+)\}/g,
		(token, name: string) => String(values[name] ?? token),
	);
}
export function locale(): string {
	return presentation.locale ?? "en-GB";
}
