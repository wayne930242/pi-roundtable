// The styles only host rooms, host pages, the read marks and the unread count need. They load with
// the first of those, as a constructed stylesheet, so the page's own stylesheet (which every visit
// downloads before it draws) stays as small as before the host rooms.

import { HOST_FORM_CSS } from "./host-style-forms.ts";
import { HOST_MESSAGE_CSS } from "./host-style-messages.ts";
import { HOST_PAGE_CSS } from "./host-style-pages.ts";

export const HOST_CSS = HOST_MESSAGE_CSS + HOST_PAGE_CSS + HOST_FORM_CSS;

let installed = false;

/** Adds the host rooms' styles to the page, once. */
export function installHostStyle(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	if (
		typeof CSSStyleSheet !== "undefined" &&
		"adoptedStyleSheets" in Document.prototype
	) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(HOST_CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = HOST_CSS;
	document.head.append(style);
}
