// The styles of an interactive block's answering: the confirm step, the notes under it and the
// disabled look. They load with the blocks chunk, as a constructed stylesheet, so the page's own
// stylesheet (which every visit downloads before it draws) stays small.

export const BLOCK_ANSWER_CSS = `
/* An interactive block: disabled where it takes no answer, with its confirm step and notes under it. */
.block-answer[data-state="readonly"] {
	opacity: 0.7;
}

.block-answer > div > * {
	display: block;
}

.block-confirm {
	margin: var(--space-2) 0 0;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface-2);
	min-width: 0;
}

.block-confirm-title {
	padding: 0 var(--space-1);
	font-size: var(--text-xs);
	color: var(--muted);
}

.block-confirm-text {
	margin: var(--space-1) 0 var(--space-2);
	padding: var(--space-2);
	border-radius: var(--radius);
	background: var(--surface);
	font-family: var(--font-mono);
	font-size: var(--text-sm);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.block-confirm-row {
	display: flex;
	gap: var(--space-2);
}

.block-note {
	margin: var(--space-1) 0 0;
	font-size: var(--text-xs);
	color: var(--muted);
}

.block-note[data-tone="error"] {
	color: var(--danger);
}
`;
