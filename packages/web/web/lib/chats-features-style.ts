// The rest of the chat home's styles: the wide column, a room's threads control and the grid of all
// features. They load with the rest (`installChatsHomeStyle`), as their own constructed stylesheet.

export const CHATS_FEATURES_CSS = `
/* ── A wide screen: the column is 380px and the open room fills the rest ──────────────────────── */

.split[data-chats] {
	grid-template-columns: 380px minmax(0, 1fr);
}

.split-empty {
	display: grid;
	flex: 1;
	place-items: center;
	color: var(--muted);
}

/* ── A room's threads, behind a control in its header ─────────────────────────────────────────── */

.room-threads {
	position: relative;
}

.room-threads-count {
	position: absolute;
	top: 0.1rem;
	right: 0.05rem;
	display: grid;
	place-items: center;
	min-width: 1.1rem;
	height: 1.1rem;
	padding: 0 0.25rem;
	border-radius: var(--radius-full);
	background: var(--accent);
	color: var(--on-accent);
	font-size: 0.65rem;
	font-weight: var(--weight-bold);
}

/* ── All features ─────────────────────────────────────────────────────────────────────────────── */

.feature-groups {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
}

.feature-group h3 {
	margin: 0 0 var(--space-2);
	color: var(--muted);
	font-size: var(--text-sm);
}

.feature-group ul {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

button.feature-tile {
	flex-direction: column;
	align-items: center;
	justify-content: flex-start;
	gap: var(--space-2);
	width: 100%;
	min-height: 5.5rem;
	padding: var(--space-1);
	border: 0;
	background: none;
	color: var(--text);
	font-size: var(--text-sm);
	text-align: center;
}

button.feature-tile:hover:not(:disabled) {
	background: none;
	border-color: transparent;
}

.feature-icon {
	position: relative;
	display: grid;
	place-items: center;
	width: 3.5rem;
	height: 3.5rem;
	border-radius: var(--radius-lg);
	background: var(--surface-2);
}

button.feature-tile:hover .feature-icon {
	background: var(--surface-3);
}

.feature-label {
	overflow-wrap: anywhere;
}

/* On a wide screen the grid is a compact popover beside its button, bottom left of the column: a row
   per entry, icon and label, in two columns. */
@media (min-width: 720px) {
	dialog.sheet.features {
		inset: auto auto 5rem var(--space-4);
		width: 24rem;
		margin: 0;
	}

	dialog.sheet.features .feature-groups {
		gap: var(--space-3);
	}

	dialog.sheet.features .feature-group h3 {
		margin-bottom: var(--space-1);
		padding-left: var(--space-2);
		font-size: var(--text-xs);
	}

	dialog.sheet.features .feature-group ul {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-1);
	}

	dialog.sheet.features button.feature-tile {
		flex-direction: row;
		justify-content: flex-start;
		gap: var(--space-2);
		min-height: 2.5rem;
		padding: 0 var(--space-2);
		border-radius: var(--radius);
		text-align: left;
	}

	dialog.sheet.features button.feature-tile:hover:not(:disabled) {
		background: var(--surface-2);
	}

	dialog.sheet.features .feature-icon,
	dialog.sheet.features button.feature-tile:hover .feature-icon {
		width: 1.5rem;
		height: 1.5rem;
		background: none;
		color: var(--muted);
	}

	dialog.sheet.features .feature-icon svg {
		width: 1.25rem;
		height: 1.25rem;
	}
}
`;
