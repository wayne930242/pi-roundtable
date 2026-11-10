// The styles of the room drawer on a host with the chat home: the home's tabs, rows and pin dock fitted
// to the drawer's width, the room's threads at the head of the list, and the bar under it. They load with
// the drawer's rows, as a constructed stylesheet, so the page's own stylesheet stays as small as before.
// The rows, the pins and the tabs are drawn by the home's own styles (`chats-home-style.ts`).

import { installStyle } from "./lazy-style.ts";

const SWITCHER_CHATS_CSS = `
/* The panel is the size of what the person can see, so the bar rides above the on-screen keyboard
   (the page keeps --app-height and --app-top at the visual viewport, as the app shell does). */
.switcher-panel:has(> .switcher-chats) {
	top: var(--app-top, 0px);
	bottom: auto;
	height: var(--app-height, 100dvh);
}

.switcher-chats {
	display: flex;
	flex: 1;
	flex-direction: column;
	min-height: 0;
}

/* ── The folder tabs: the home's, edge to edge in the panel ─────────────────────────────────────── */

.switcher-tabs {
	flex: none;
	padding: var(--space-3) 0 var(--space-2);
}

.switcher-tabs fieldset.chips {
	margin: 0;
	padding: 0 var(--space-3);
}

/* ── The list: the room's threads, other folders' unread rooms, then the rows ───────────────────── */

.switcher-chats .switcher-scroll {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding-top: var(--space-1);
}

.switcher-chats-threads {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
}

.switcher-chats-threads h2,
.switcher-chats .elsewhere h2,
.switcher-chats .folder-section h2 {
	margin: 0 var(--space-2);
}

.switcher-chats-threads h2 {
	color: var(--muted);
	font-size: var(--text-sm);
	font-weight: 600;
}

/* The rooms page's thread list, fitted to the drawer's width. */
.switcher-chats-threads .thread-group,
.switcher-chats-threads .helper-group {
	margin: 0;
}

.switcher-chats-threads .thread-card .thread-link {
	gap: var(--space-2);
	min-height: 2.75rem;
	padding: var(--space-1) var(--space-2);
	font-size: var(--text-xs);
}

/* ── The pin dock: four pins fit the panel; more scroll sideways ────────────────────────────────── */

.switcher-chats .pins.pin-dock {
	flex: none;
	gap: var(--space-1);
	margin: 0;
	padding: var(--space-2) var(--space-2) var(--space-1);
	border-top: 1px solid var(--border);
}

.switcher-chats .pin-dock .pin-item {
	width: 4.25rem;
}

/* ── The bar: Home, the search and the add menu ─────────────────────────────────────────────────── */

.switcher-bar {
	flex: none;
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-3);
}

/* With no dock the list ends at the bar. */
.switcher-scroll + .switcher-bar {
	border-top: 1px solid var(--border);
}

button.switcher-bar-button {
	flex: none;
	width: 3rem;
	min-width: 3rem;
	height: 3rem;
	border-radius: var(--radius-full);
	background: var(--surface-2);
	color: var(--text);
}

.switcher-bar .switcher-search {
	flex: 1;
	min-width: 0;
	margin: 0;
}
`;

export const installSwitcherChatsStyle = (): void =>
	installStyle("switcher-chats", SWITCHER_CHATS_CSS);
