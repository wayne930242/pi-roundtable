// The folder tabs, the folder tag on a row, the section of other folders' unread rooms, and the phone's
// pin dock. Status shows through the count badge and the accent, and every border is one pixel on all
// four sides.

export const CHATS_CHIPS_CSS = `
/* ── Folder tabs: one row that scrolls sideways; 48px tall on a phone, shorter in a column ─────── */

fieldset.chips {
	display: flex;
	/* The page's own .chips rule wraps; these tabs scroll sideways instead. */
	flex-wrap: nowrap;
	min-width: 0;
	gap: var(--space-2);
	margin: 0 calc(var(--space-4) * -1);
	padding: 0 var(--space-4);
	border: 0;
	overflow-x: auto;
	scrollbar-width: none;
	/* The edges fade where more tabs wait beyond them. */
	mask-image: linear-gradient(
		to right,
		transparent,
		#000 var(--space-4),
		#000 calc(100% - var(--space-4)),
		transparent
	);
}

.chips::-webkit-scrollbar {
	display: none;
}

/* In the column the tabs stay one row too, shorter, as a pointer needs no 48px target. */
.chats[data-column] fieldset.chips {
	gap: var(--space-1);
}

.chats[data-column] button.chip {
	height: 2.25rem;
	padding: 0 0.625rem;
	border-radius: var(--radius-full);
	font-size: var(--text-sm);
}

button.chip {
	flex: none;
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	height: 3rem;
	padding: 0 var(--space-4);
	border: 1px solid var(--border);
	border-radius: 14px;
	background: var(--surface);
	color: var(--text);
	font-family: inherit;
	font-size: 1rem;
	white-space: nowrap;
}

button.chip:hover:not(:disabled) {
	background: var(--surface-2);
	border-color: var(--border);
}

button.chip[aria-pressed="true"],
button.chip[aria-pressed="true"]:hover:not(:disabled) {
	border-color: var(--accent);
	background: var(--accent);
	color: var(--on-accent);
}

.chip-count {
	display: grid;
	place-items: center;
	min-width: 1.5rem;
	height: 1.5rem;
	padding: 0 0.45rem;
	border-radius: var(--radius-full);
	background: var(--accent);
	color: var(--on-accent);
	font-size: var(--text-sm);
	font-weight: 600;
}

button.chip[aria-pressed="true"] .chip-count {
	background: var(--on-accent);
	color: var(--accent);
}

/* ── The folder tag on a row ──────────────────────────────────────────────────────────────────── */

.folder-tag {
	flex: none;
	max-width: 8rem;
	overflow: hidden;
	color: var(--muted);
	font-size: var(--text-sm);
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* ── Other folders' unread rooms, above the chosen folder's list ──────────────────────────────── */

.elsewhere,
.folder-section {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
}

.elsewhere h2,
.folder-section h2 {
	margin: 0;
	color: var(--muted);
	font-size: var(--text-sm);
	font-weight: 600;
}

/* ── The pin dock: one row of figures above the bottom bar, for a phone ───────────────────────── */

.pins.pin-dock {
	display: flex;
	gap: var(--space-2);
	margin: 0 calc(var(--space-4) * -1);
	padding: 0 var(--space-4);
	overflow-x: auto;
	scrollbar-width: none;
}

.pin-dock::-webkit-scrollbar {
	display: none;
}

.pin-dock .pin-item {
	flex: none;
	width: 5rem;
}
`;
