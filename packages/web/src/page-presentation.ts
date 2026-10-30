import type { ConsolePresentation } from "./features.ts";
import { escapeHtml } from "./http.ts";
import { PAGE_COLORS } from "./page-colors.ts";

/** The tags that make the page installable; their URLs resolve against the base, so they follow it. */
const pwaTags = (look: "modern" | "camelot"): string =>
	'<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials">' +
	`<meta name="theme-color" content="${PAGE_COLORS[look].light}" media="(prefers-color-scheme: light)">` +
	`<meta name="theme-color" content="${PAGE_COLORS[look].dark}" media="(prefers-color-scheme: dark)">` +
	'<link rel="apple-touch-icon" href="./icons/apple-180.png">' +
	'<meta name="apple-mobile-web-app-capable" content="yes">';

/**
 * The icon links of a page served under `mount`: the round-table mark as an SVG when the icon
 * directory has one, and the 192 px PNG every icon directory has (the manifest names it). Without
 * them a browser asks the site root for `/favicon.ico`, which is not this app's.
 */
export const iconLinks = (mount: string, svg: boolean): string => {
	const base = escapeHtml(mount);
	const mark = svg
		? `<link rel="icon" href="${base}/icons/mark.svg" type="image/svg+xml" sizes="any">`
		: "";
	return `${mark}<link rel="icon" href="${base}/icons/192.png" type="image/png">`;
};

/** What a page says about itself to a tab, a search result and a link preview. */
export interface PageMeta {
	title: string;
	description: string;
	/** The console's origin, so `og:image` is an absolute URL. */
	origin: string;
	/** The path the console is served under. */
	mount: string;
	/** Whether the icon directory has `mark.svg`. */
	svg: boolean;
}

/** The text a host that sets no `description` gets. */
export const defaultDescription = (title: string): string =>
	`Chat with your agent team in ${title}.`;

const metaTags = (meta: PageMeta): string =>
	`<meta name="description" content="${escapeHtml(meta.description)}">` +
	`<meta property="og:title" content="${escapeHtml(meta.title)}">` +
	`<meta property="og:description" content="${escapeHtml(meta.description)}">` +
	`<meta property="og:image" content="${escapeHtml(`${meta.origin}${meta.mount}/icons/512.png`)}">`;

/** Authenticated, inert bootstrap data localizes even a failed first API request without inline scripts. */
export function presentPage(
	body: Uint8Array,
	mount: string | undefined,
	presentation: ConsolePresentation | undefined,
	look: "modern" | "camelot" = "modern",
	meta?: PageMeta,
): Uint8Array<ArrayBuffer> | string {
	// Not in web/index.html: the bundler would try to resolve and rewrite these URLs.
	// The base comes first: under path routing a relative link before it resolves against a deep URL.
	let head = "<head>";
	if (mount) head += `<base href="${escapeHtml(`${mount}/`)}">`;
	head += pwaTags(look);
	if (meta) head += iconLinks(meta.mount, meta.svg) + metaTags(meta);
	if (presentation)
		head += `<meta name="roundtable-console-presentation" content="${escapeHtml(JSON.stringify(presentation))}">`;
	// After the base, so it resolves under the mount; a script of the page's own origin, which its policy allows.
	head += '<script src="./theme-init.js"></script>';
	let html = new TextDecoder().decode(body).replace("<head>", () => head);
	// web/index.html ships a placeholder: the page is not rendered until the bundle sets the title.
	if (meta)
		html = html.replace(
			/<title>[^<]*<\/title>/,
			() => `<title>${escapeHtml(meta.title)}</title>`,
		);
	if (presentation?.locale)
		html = html.replace(
			/(<html[^>]*lang=")[^"]*(")/,
			(_all, prefix: string, suffix: string) =>
				`${prefix}${escapeHtml(presentation.locale ?? "en")}${suffix}`,
		);
	return html;
}
