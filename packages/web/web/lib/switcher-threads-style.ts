// The styles of a room's threads in the room drawer: the toggle beside the row, and the rooms page's
// thread list fitted to the drawer's width. They load with the drawer's rows, as a constructed
// stylesheet, so the page's own stylesheet stays as small as before.

import { installStyle } from "./lazy-style.ts";

const SWITCHER_THREADS_CSS = `
/* A room with threads: its row, the toggle beside it, and the threads under both once opened. */
.switcher-list > li[data-threads] {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
}

.switcher-threads-toggle {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	min-width: var(--touch);
	min-height: var(--touch);
	padding: 0 var(--space-2);
	border: 0;
	border-radius: var(--radius);
	background: none;
	color: var(--muted);
	font-size: var(--text-sm);
}

.switcher-threads-toggle:hover {
	background: var(--surface-2);
}

.switcher-threads-toggle svg {
	transition: transform var(--dur-fast) var(--ease-out);
}

.switcher-threads-toggle[aria-expanded="true"] svg {
	transform: rotate(90deg);
}

.switcher-threads {
	grid-column: 1 / -1;
}

/* The rooms page's thread list, fitted to the drawer's width. */
.switcher-threads .thread-group {
	margin: var(--space-1) 0 var(--space-2) var(--space-4);
}

.switcher-threads .helper-group {
	margin-left: var(--space-4);
}

.switcher-threads .thread-card .thread-link {
	gap: var(--space-2);
	min-height: 2.75rem;
	padding: var(--space-1) var(--space-2);
	font-size: var(--text-xs);
}
`;

export const installSwitcherThreadsStyle = (): void =>
	installStyle("switcher-threads", SWITCHER_THREADS_CSS);
