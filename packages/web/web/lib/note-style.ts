// The styles of an internal note in an agent room, and of a message between agents. They load
// with the first such row shown, as a constructed stylesheet, so the page's own stylesheet (which
// every visit downloads before it draws) stays as small as before notes.

const NOTE_CSS = `
/* A note is the room's people talking among themselves: a plain, dashed card, never the accent bubble of a message to the agent. */
.message[data-note] .bubble,
.message[data-note][data-mine] .bubble {
	border: 1px dashed var(--control-border);
	background: var(--surface-3);
	color: var(--text);
	box-shadow: none;
}

.message[data-note][data-mine] .bubble a,
.message[data-note][data-mine] .bubble code {
	color: var(--accent);
}

.message[data-note][data-mine] .prose code,
.message[data-note][data-mine] .prose blockquote {
	background: var(--surface);
}

.message[data-note][data-mine] .code-block pre {
	background: var(--surface);
	border-color: var(--border);
}

.message[data-note][data-mine] .file-chip {
	color: var(--text);
}

.note-chip {
	padding: 0 var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-3);
	color: var(--muted);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
}

/* A message between agents: one quiet line in the room's flow that opens to the whole text. */
.line.intercom {
	justify-content: flex-start;
}

.intercom-card {
	max-width: 100%;
	min-width: 0;
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface-2);
}

.intercom-card > summary,
div.intercom-card {
	display: flex;
	gap: var(--space-2);
	min-width: 0;
	list-style: none;
}

.intercom-card > summary {
	cursor: pointer;
}

.intercom-card > summary::-webkit-details-marker {
	display: none;
}

.intercom-card > summary::after {
	content: "▸";
	margin-left: auto;
}

.intercom-card[open] > summary::after {
	content: "▾";
}

.intercom-card > summary:hover {
	color: var(--text);
}

.intercom-heading {
	flex: none;
	font-weight: var(--weight-medium);
}

.line[data-intercom="failed"] .intercom-heading {
	color: var(--danger);
}

.intercom-summary {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.intercom-body {
	margin-top: var(--space-2);
	color: var(--text);
	font-size: var(--text-sm);
}
`;

let installed = false;

/** Adds the note styles to the page, once. */
export function installNoteStyle(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	if (
		typeof CSSStyleSheet !== "undefined" &&
		"adoptedStyleSheets" in Document.prototype
	) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(NOTE_CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = NOTE_CSS;
	document.head.append(style);
}
