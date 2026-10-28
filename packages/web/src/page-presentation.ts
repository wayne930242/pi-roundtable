import type { ConsolePresentation } from "./features.ts";
import { THEME_COLOR } from "./pwa.ts";

const attribute = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&#39;");

/** The tags that make the page installable; the URLs resolve against the page, so the mount does not matter. */
const PWA_TAGS =
	'<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials">' +
	`<meta name="theme-color" content="${THEME_COLOR}">` +
	'<link rel="apple-touch-icon" href="./icons/apple-180.png">' +
	'<meta name="apple-mobile-web-app-capable" content="yes">';

/** Authenticated, inert bootstrap data localizes even a failed first API request without inline scripts. */
export function presentPage(
	body: Uint8Array,
	mount: string | undefined,
	presentation: ConsolePresentation | undefined,
): Uint8Array<ArrayBuffer> | string {
	// Not in web/index.html: the bundler would try to resolve and rewrite these URLs.
	let head = `<head>${PWA_TAGS}`;
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
