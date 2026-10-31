// The styles of the composer's member list. They load with the list, as a constructed stylesheet,
// so the page's own stylesheet (which every visit downloads before it draws) stays as small as before.

export const MENTION_MENU_CSS = `
.composer {
	position: relative;
}

/* Over the box, in its column; the box's own bar stays where it is. */
.mention-menu {
	position: absolute;
	left: var(--space-3);
	right: var(--space-3);
	bottom: 100%;
	z-index: 20;
	margin: 0 0 var(--space-1);
	padding: var(--space-1);
	max-height: 14rem;
	overflow-y: auto;
	list-style: none;
	border: 1px solid var(--border);
	border-radius: var(--radius-lg, 0.75rem);
	background: var(--surface);
	box-shadow: var(--shadow-2, var(--shadow-1));
}

.mention-menu button {
	display: block;
	width: 100%;
	min-height: var(--touch);
	padding: 0 var(--space-3);
	border: 0;
	border-radius: var(--radius-md, 0.5rem);
	background: none;
	color: var(--text);
	font-size: var(--text-sm);
	text-align: left;
	cursor: pointer;
}

.mention-menu button:hover:not(:disabled),
.mention-menu button[aria-selected="true"] {
	background: color-mix(in srgb, var(--accent) 14%, var(--surface));
	color: var(--text);
}
`;
