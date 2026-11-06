// The Edit knight sheet's tabs and the skill picker's styles, which load with them.

import { installStyle } from "./lazy-style.ts";

const AGENT_SHEET_CSS = `
/* The Edit knight sheet's tabs stay under its header while a panel scrolls. */
.agent-tabs {
	position: sticky;
	top: 0;
	z-index: 2;
	padding: var(--space-1) 0;
	background: var(--surface);
}

.agent-tabs button {
	flex: 1;
	min-width: 0;
	padding: 0 var(--space-2);
	white-space: nowrap;
}

/* A knight's skills: the carried ones as chips, a search, group filters and one line per skill. */
.skill-chips {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
}

.skill-chip {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-height: 2rem;
	max-width: 100%;
	padding: 0 var(--space-2) 0 var(--space-3);
	border: 1px solid var(--control-border);
	border-radius: var(--radius-full);
	background: var(--surface-2);
	color: var(--text);
	font-size: var(--text-sm);
	font-weight: 400;
	overflow-wrap: anywhere;
}

button.skill-chip:hover:not(:disabled) {
	border-color: var(--border-strong);
	background: var(--surface-3);
}

.skill-chip[data-builtin] {
	padding-right: var(--space-3);
	color: var(--muted);
	background: transparent;
}

.skill-chip[data-missing],
.skill-rows li[data-missing] strong {
	text-decoration: line-through;
}

.skill-search {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: var(--space-2);
}

.skill-search input {
	flex: 1;
	min-width: 0;
}

.skill-filters {
	max-height: none;
	margin: 0;
	padding: 0;
	border: 0;
}

.skill-rows {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
}

.skill-rows li {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-width: 0;
	border-bottom: 1px solid var(--border);
}

button.skill-row-text {
	display: flex;
	flex: 1;
	flex-direction: column;
	align-items: flex-start;
	min-width: 0;
	min-height: 2.75rem;
	padding: var(--space-1) 0;
	border: 0;
	background: transparent;
	color: var(--text);
	font-weight: 400;
	text-align: left;
}

button.skill-row-text:hover:not(:disabled) {
	background: transparent;
}

.skill-row-text .meta {
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.skill-row-text .meta[data-full] {
	white-space: normal;
}
`;

/** Adds the agent sheet's tabs' and the skill picker's styles to the page, once. */
export const installAgentSheetStyle = (): void =>
	installStyle("agent-sheet", AGENT_SHEET_CSS);
