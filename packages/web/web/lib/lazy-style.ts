// Styles that belong to one lazy part of the page. Each loads with that part, as a constructed
// stylesheet, so the page's own stylesheet (which every visit downloads before it draws) stays small.

// The ids each document has, so a new document (a test's next page) takes its styles again.
const done = new WeakMap<Document, Set<string>>();

/** Adds a style to the page, once for each `id`; it is in place before the part that needs it paints. */
export function installStyle(id: string, css: string): void {
	if (typeof document === "undefined") return;
	const ids = done.get(document) ?? new Set<string>();
	if (ids.has(id)) return;
	done.set(document, ids.add(id));
	if (
		typeof CSSStyleSheet !== "undefined" &&
		"adoptedStyleSheets" in Document.prototype
	) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(css);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
}
