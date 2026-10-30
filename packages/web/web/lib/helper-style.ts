// The styles of the temp knights' rows under their knight. They load with the list that draws them,
// as a constructed stylesheet, so the page's own stylesheet stays as small as before temp knights.

export const HELPER_CSS = `
.helper-group {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	margin: var(--space-2) 0 var(--space-2) var(--space-5);
}

.helper-head {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 2rem;
	padding: 0 var(--space-2);
	border: 0;
	background: transparent;
	color: var(--muted);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	text-align: left;
}

.helper-head::before {
	content: "";
	flex: none;
	width: 0.5rem;
	height: 0.5rem;
	border-right: 2px solid currentColor;
	border-bottom: 2px solid currentColor;
	transform: rotate(-45deg);
	transition: transform 120ms var(--ease-out);
}

.helper-head[aria-expanded="true"]::before {
	transform: rotate(45deg);
}

.helper-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.helper-link {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-width: 0;
	min-height: var(--touch);
	padding: 0 var(--space-3);
	border-radius: var(--radius);
	color: inherit;
	text-decoration: none;
}

.helper-link:hover {
	background: var(--surface-2);
}

.helper-link[aria-current="page"] {
	background: var(--accent-soft);
}

.helper-link strong {
	min-width: 0;
	overflow: hidden;
	font-weight: var(--weight-medium);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.helper-state {
	display: flex;
	flex: none;
	align-items: center;
	gap: var(--space-2);
	margin-left: auto;
	color: var(--muted);
	font-size: var(--text-xs);
}

.helper-link[data-finished] strong,
.helper-link[data-finished] .helper-state {
	opacity: 0.6;
}

.helper-dot {
	width: 0.5rem;
	height: 0.5rem;
	border-radius: 50%;
	background: var(--accent);
	animation: helper-pulse 1.2s ease-in-out infinite;
}

@keyframes helper-pulse {
	50% {
		opacity: 0.35;
	}
}

@media (prefers-reduced-motion: reduce) {
	.helper-dot {
		animation: none;
	}
}
`;

let installed = false;

/** Adds the rows' styles to the page, once. */
export function installHelperStyle(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	if (
		typeof CSSStyleSheet !== "undefined" &&
		"adoptedStyleSheets" in Document.prototype
	) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(HELPER_CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = HELPER_CSS;
	document.head.append(style);
}
