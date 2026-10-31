// The character creator's styles. They load with the creator's chunk, as a constructed stylesheet,
// so the page's own stylesheet (which every visit downloads before it draws) stays small.

export const CREATOR_CSS = `
.creator {
	display: grid;
	gap: var(--space-5);
	align-items: start;
}

@media (min-width: 720px) {
	.creator {
		grid-template-columns: 13rem minmax(0, 1fr);
	}

	.creator-preview {
		position: sticky;
		top: var(--space-4);
	}
}

.creator-preview {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	padding: var(--space-4);
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	background: color-mix(
		in srgb,
		var(--agent-accent, var(--accent)) 8%,
		var(--surface)
	);
}

.creator-body {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	min-width: 0;
}

.creator-field {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-width: 0;
}

.creator-field h3 {
	font-size: var(--text-sm);
	color: var(--muted);
	font-weight: var(--weight-medium);
}

/* In the phone's sheet the sheet's own title says what the group is. */
dialog.sheet dialog.sheet .creator-field > h3 {
	display: none;
}

.creator-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
	gap: var(--space-2);
}

.creator-strip {
	display: flex;
	gap: var(--space-2);
	/* Room for the chosen tile's ring, which the scrolling strip would otherwise clip. */
	padding: 3px 3px var(--space-1);
	overflow-x: auto;
	scroll-snap-type: x proximity;
}

/* The row fades toward the side where more of it lies, so a cut-off tile reads as "scroll" and not as the end. */
.creator-strip[data-more="end"] {
	-webkit-mask-image: linear-gradient(
		to right,
		#000 calc(100% - 2.5rem),
		transparent
	);
	mask-image: linear-gradient(to right, #000 calc(100% - 2.5rem), transparent);
}
.creator-strip[data-more="start"] {
	-webkit-mask-image: linear-gradient(
		to left,
		#000 calc(100% - 2.5rem),
		transparent
	);
	mask-image: linear-gradient(to left, #000 calc(100% - 2.5rem), transparent);
}
.creator-strip[data-more="both"] {
	-webkit-mask-image: linear-gradient(
		to right,
		transparent,
		#000 2.5rem,
		#000 calc(100% - 2.5rem),
		transparent
	);
	mask-image: linear-gradient(
		to right,
		transparent,
		#000 2.5rem,
		#000 calc(100% - 2.5rem),
		transparent
	);
}

.creator-tile {
	display: flex;
	flex: none;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	min-width: 4.25rem;
	padding: var(--space-2) var(--space-1);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface);
	color: var(--text);
	font-size: var(--text-xs);
	scroll-snap-align: start;
}

.creator-grid .creator-tile {
	min-width: 0;
}

.creator-tile span {
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.creator-tile:hover:not(:disabled) {
	border-color: var(--control-border);
	background: var(--surface-2);
}

.creator-tile[aria-pressed="true"],
.creator-tile[aria-pressed="true"]:hover:not(:disabled),
.creator-swatch[aria-pressed="true"],
.creator-swatch[aria-pressed="true"]:hover:not(:disabled) {
	border-color: var(--agent-accent, var(--accent));
	background: color-mix(
		in srgb,
		var(--agent-accent, var(--accent)) 14%,
		var(--surface)
	);
	box-shadow: 0 0 0 2px var(--agent-accent, var(--accent));
}

.creator-swatches {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	padding: 0;
	border: 0;
}

.creator-swatch {
	width: 2.25rem;
	height: 2.25rem;
	min-height: 0;
	padding: 0;
	border: 2px solid var(--surface);
	border-radius: var(--radius-full);
	box-shadow: 0 0 0 1px var(--control-border);
}

.creator-custom {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-4);
}

.creator-custom label {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-1);
	font-size: var(--text-sm);
	color: var(--muted);
}

.creator-custom input[type="color"],
.creator-swatches input[type="color"] {
	width: 2.25rem;
	height: 2.25rem;
	padding: 0;
	border: 1px solid var(--control-border);
	border-radius: var(--radius-sm);
	background: transparent;
}

.field-error {
	margin: 0;
	color: var(--danger);
	font-size: var(--text-sm);
}

.creator-sections {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.creator-section {
	display: flex;
	width: 100%;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	text-align: left;
}

.creator-actions {
	flex-wrap: wrap;
}
`;
