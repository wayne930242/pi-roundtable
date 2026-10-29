// The styles only the arranged room list needs: folders, the arrange bar, and a lifted row or folder.
// They load with the arranged list, as a constructed stylesheet, so the page's own stylesheet (which
// every visit downloads before it draws) stays as small as before pins and folders.

const CSS = `
/* Folders of the room list, and the lifted row or folder while it is dragged. */
.folder {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

.folder-head {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 2.75rem;
	padding: 0 var(--space-1) 0 var(--space-2);
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	background: var(--surface-2);
}

.folder-toggle {
	display: flex;
	flex: 1;
	align-items: center;
	gap: var(--space-2);
	min-width: 0;
	min-height: 2.75rem;
	padding: 0;
	border: 0;
	background: transparent;
	color: inherit;
	text-align: left;
}

.folder-toggle strong {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
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
			sheet.replaceSync(CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);
}
