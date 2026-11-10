// The styles of selecting several rows: the checkbox, the age chips, the bar at the foot of the page
// and its result. They load with the first page that offers a selection, as a constructed stylesheet,
// so the page's own stylesheet stays as small as before it.

import { installStyle } from "./lazy-style.ts";

export const SELECT_CSS = `
.section-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	min-height: var(--touch);
}

.section-head .section-title {
	margin: 0;
}

button.compact.select-all {
	flex: none;
	min-height: 2.25rem;
}

input[type="checkbox"].select-box {
	flex: none;
	width: 1.5rem;
	height: 1.5rem;
	margin: 0;
	cursor: pointer;
}

.select-row {
	display: flex;
	flex: 1;
	flex-direction: row;
	align-items: center;
	color: var(--text);
	font-size: inherit;
	gap: var(--space-3);
	min-width: 0;
	padding: var(--space-2);
	border-radius: var(--radius);
	cursor: pointer;
	-webkit-user-select: none;
	user-select: none;
}

.select-row:hover {
	background: var(--surface-2);
}

.select-row[data-chosen] {
	background: var(--accent-soft);
}

.select-row[data-in-group] {
	margin-left: var(--space-6);
}

.select-row .room-row-main,
.select-row .menu-text {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 0.15rem;
	min-width: 0;
}

.select-row .meta {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.select-chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.select-chips button {
	min-height: 2.25rem;
	padding: 0 var(--space-3);
	border-radius: var(--radius-full);
	background: var(--surface);
	border-color: var(--control-border);
	color: var(--text);
}

.select-chips button:hover:not(:disabled) {
	background: var(--surface-2);
	border-color: var(--control-border);
}

.select-chips button[aria-pressed="true"] {
	background: var(--accent);
	border-color: var(--accent);
	color: var(--on-accent);
}

.select-chips .count {
	opacity: 0.8;
	font-variant-numeric: tabular-nums;
}

.select-dock {
	position: sticky;
	bottom: 0;
	z-index: 6;
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin-top: auto;
	padding-bottom: var(--safe-bottom);
}

.select-bar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	padding: var(--space-3);
	border: 1px solid var(--border-strong);
	border-radius: var(--radius-lg);
	background: var(--raised);
	box-shadow: var(--shadow-2);
}

.select-bar .select-count {
	flex: 1;
	min-width: 6rem;
	font-weight: var(--weight-bold);
}

.select-bar progress {
	flex-basis: 100%;
	width: 100%;
	height: 0.4rem;
	accent-color: var(--accent);
}

.select-result {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-3);
	border: 1px solid var(--danger);
	border-radius: var(--radius-lg);
	background: var(--danger-soft);
	font-size: var(--text-sm);
}

.select-result ul {
	margin: 0;
	padding-left: var(--space-4);
}

.select-result button {
	align-self: flex-end;
}

body[data-selecting] .toaster {
	bottom: calc(6.5rem + var(--safe-bottom));
}

.confirm-names {
	margin: 0;
	padding-left: var(--space-4);
}

/* ── The overview's rows: a title, one line of facts, and the row's menu ───────────────────────── */

.stored-list {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
}

.stored-row {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 3.75rem;
	padding: var(--space-1) var(--space-2);
	border-bottom: 1px solid var(--border);
}

.stored-row .stored-main {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 0.1rem;
	min-width: 0;
}

.stored-row .stored-title {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.stored-row .meta {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* A folded body is hidden by its attribute, which .stack's display would otherwise override. */
.fold-body[hidden] {
	display: none;
}

.fold-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
}

.fold-head .fold-toggle {
	flex: 1;
	min-width: 0;
}

.fold-head .meta {
	flex: 0 1 auto;
	text-align: right;
}
`;

/** Puts the styles of selecting in the page. */
export const installSelectStyle = (): void =>
	installStyle("select", SELECT_CSS);
