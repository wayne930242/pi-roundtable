import type { ConsolePresentation } from "./features.ts";

const attribute = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&#39;");

/** Authenticated, inert bootstrap data localizes even a failed first API request without inline scripts. */
export function presentPage(
	body: Uint8Array,
	mount: string | undefined,
	presentation: ConsolePresentation | undefined,
): Uint8Array<ArrayBuffer> | string {
	if (!mount && !presentation) return new Uint8Array(body);
	let head = "<head>";
	if (mount) head += `<base href="${attribute(`${mount}/`)}">`;
	if (presentation)
		head += `<meta name="roundtable-console-presentation" content="${attribute(JSON.stringify(presentation))}">`;
	let html = new TextDecoder().decode(body).replace("<head>", () => head);
	if (presentation?.locale)
		html = html.replace(
			/(<html[^>]*lang=")[^"]*(")/,
			(_all, prefix: string, suffix: string) =>
				`${prefix}${attribute(presentation.locale ?? "en")}${suffix}`,
		);
	return html;
}
