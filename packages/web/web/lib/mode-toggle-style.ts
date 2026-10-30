// The styles of the composer's mode toggle. They load with the toggle, as a constructed stylesheet,
// so the page's own stylesheet (which every visit downloads before it draws) stays as small as before.

export const MODE_TOGGLE_CSS = `
/* One choice of how to write, in the composer's column over the bar, wherever the pane is wide. */
.mode-toggle {
	display: inline-flex;
	align-items: center;
	align-self: flex-start;
	gap: var(--space-2);
	min-height: var(--touch);
	padding: 0 var(--space-3) 0 var(--space-1);
	border: 1px solid transparent;
	border-radius: var(--radius-full);
	background: none;
	color: var(--muted);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	cursor: pointer;
}

.mode-toggle[aria-checked="true"] {
	color: var(--text);
}

.mode-toggle:hover:not(:disabled) {
	background: var(--surface);
	border-color: transparent;
}

.mode-toggle-track {
	position: relative;
	flex: none;
	width: 2.25rem;
	height: 1.35rem;
	border: 1px solid var(--control-border);
	border-radius: var(--radius-full);
	background: var(--surface-3);
	transition:
		background-color var(--dur) var(--ease-out),
		border-color var(--dur) var(--ease-out);
}

.mode-toggle-track::after {
	content: "";
	position: absolute;
	left: 2px;
	top: 50%;
	width: 1rem;
	height: 1rem;
	margin-top: -0.5rem;
	border-radius: var(--radius-full);
	background: var(--control-border);
	transition:
		transform var(--dur) var(--ease-out),
		background-color var(--dur) var(--ease-out);
}

.mode-toggle[aria-checked="true"] .mode-toggle-track {
	border-color: var(--accent);
	background: var(--accent);
}

.mode-toggle[aria-checked="true"] .mode-toggle-track::after {
	background: var(--bg);
	transform: translateX(0.9rem);
}
`;

let installed = false;

/** Adds the toggle's styles to the page, once. */
export function installModeToggleStyle(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	if (
		typeof CSSStyleSheet !== "undefined" &&
		"adoptedStyleSheets" in Document.prototype
	) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(MODE_TOGGLE_CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = MODE_TOGGLE_CSS;
	document.head.append(style);
}
