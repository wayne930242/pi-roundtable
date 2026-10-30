// The styles only the arranged room list needs: folders, the arrange bar, and a lifted row or folder.
// They load with the arranged list, as a constructed stylesheet, so the page's own stylesheet (which
// every visit downloads before it draws) stays as small as before pins and folders.

export const ARRANGED_CSS = `
.folder-body[hidden] {
	display: none;
}

/* An empty place to drop (the pinned list, a folder of the drawer) shows only while a row is lifted. */
[data-empty] {
	display: none;
}

[data-reordering] [data-empty] {
	display: block;
	min-height: 2.75rem;
}

/* Folders of the room list, and the lifted row or folder while it is dragged. */
.folder {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

/* An ordinary folder is a light section header, tappable, like the Home and Pinned labels: no box. */
.folder-head {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 2.75rem;
	padding: 0;
}

/*
 * The fold button wears the section label. It sits under the base "button:hover:not(:disabled)"
 * (an accent fill), which a plain class would lose to; so each state is named here, and none of them
 * changes the text colour away from the page's own text.
 */
.folder-head .folder-toggle {
	display: flex;
	flex: 1;
	align-items: center;
	justify-content: flex-start;
	gap: var(--space-2);
	min-width: 0;
	min-height: 2.75rem;
	padding: 0 var(--space-2);
	border: 0;
	border-radius: var(--radius);
	background: transparent;
	color: var(--muted);
	font-weight: var(--weight-medium);
	text-align: left;
}

.folder-head .folder-toggle:hover:not(:disabled),
.folder-head .folder-toggle:active:not(:disabled),
.folder-head .folder-toggle:focus-visible {
	border: 0;
	background: color-mix(in srgb, var(--text) 8%, transparent);
	color: var(--text);
}

.folder-head .folder-toggle:active:not(:disabled) {
	transform: none;
}

.folder-toggle strong {
	overflow: hidden;
	color: inherit;
	font-size: var(--text-xs);
	letter-spacing: 0.06em;
	text-overflow: ellipsis;
	text-transform: uppercase;
	white-space: nowrap;
}

.folder-toggle .meta {
	flex: none;
	color: inherit;
	font-size: var(--text-xs);
	white-space: nowrap;
}

/* The pictures of a folded folder's rooms, overlapping, then how many more. */
.folder-stack {
	display: flex;
	flex: none;
	align-items: center;
	margin-left: var(--space-1);
}

.folder-stack > * + * {
	margin-left: -0.5rem;
}

.folder-stack-item,
.folder-stack-more {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 1.75rem;
	height: 1.75rem;
	overflow: hidden;
	border-radius: 50%;
	background: var(--surface);
	box-shadow: 0 0 0 2px var(--bg);
}

.folder-stack-more {
	background: var(--surface-2);
	color: var(--muted);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
}

.folder-chevron {
	flex: none;
	transition: transform var(--dur-fast) var(--ease-out);
}

.folder-chevron[data-open] {
	transform: rotate(90deg);
}

.folder-head .muted-mark[data-partial] {
	opacity: 0.55;
}

.folder-more,
.row-more {
	flex: none;
}

.folder-body {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

.folder-empty {
	margin: 0;
	padding: var(--space-2) var(--space-3);
}

.room-list > li {
	position: relative;
}

/* The menu button sits over the row's right edge: the row keeps that strip clear of its chevron and time. */
.room-list > li[data-arranging] > .room-row {
	padding-right: 3.75rem;
}

.room-list .row-more {
	position: absolute;
	top: var(--space-2);
	right: var(--space-2);
}

.arrange-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
}

[data-drop-zone] {
	position: relative;
}

[data-lifted] {
	position: relative;
	z-index: 5;
	box-shadow: var(--shadow-3);
	transition: none;
	touch-action: none;
}

[data-reordering] {
	-webkit-user-select: none;
	user-select: none;
}

[data-reordering] [data-drop-item]:not([data-lifted]),
[data-reordering] [data-folder-block]:not([data-lifted]) {
	transition: transform var(--dur-fast) var(--ease-out);
}

[data-drop-target] {
	outline: 2px dashed var(--accent);
	outline-offset: 4px;
	border-radius: var(--radius-lg);
}

.drop-line {
	position: absolute;
	left: 0;
	right: 0;
	height: 3px;
	margin-top: -2px;
	border-radius: 2px;
	background: var(--accent);
	pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
	.folder-chevron,
	[data-reordering] [data-drop-item]:not([data-lifted]),
	[data-reordering] [data-folder-block]:not([data-lifted]) {
		transition: none;
	}
}
`;

let installed = false;

/** Adds the arranged list's styles to the page, once. */
export function installArrangedStyle(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	if (
		typeof CSSStyleSheet !== "undefined" &&
		"adoptedStyleSheets" in Document.prototype
	) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(ARRANGED_CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = ARRANGED_CSS;
	document.head.append(style);
}
