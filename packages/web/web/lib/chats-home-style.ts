// The styles of the chat home: the pins, the folder chips, the list without cards, the bottom bar,
// the grid of all features. (The shell under it, with no rail and no tab bar, is in `styles.css`.)
// They load with the home as a constructed stylesheet, once for the page, so the page's own
// stylesheet, which every visit downloads before it draws, stays as small as before.
//
// Status shows through a badge, an icon or a tint, and a card or a button has a border on all four
// sides or on none: the open room's row keeps a uniform accent border, never one colored edge.

import { CHATS_FEATURES_CSS } from "./chats-features-style.ts";
import { installStyle } from "./lazy-style.ts";

export const CHATS_HOME_CSS = `
/* ── The home ──────────────────────────────────────────────────────────────────────────────────── */

.chats {
	flex: 1;
	max-width: 40rem;
	gap: var(--space-4);
	padding-bottom: 0;
}

.chats[data-column] {
	max-width: none;
}

.chats-top {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-height: var(--touch);
}

.chats-top-end {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	margin-left: auto;
}

.chats-me {
	display: grid;
	flex: none;
	place-items: center;
	width: var(--touch);
	height: var(--touch);
	border-radius: var(--radius-full);
	background: var(--accent-soft);
	color: var(--accent-ink);
	font-weight: var(--weight-bold);
	text-decoration: none;
}

button.chats-waiting {
	min-height: var(--touch);
	padding: 0 var(--space-4);
	border-radius: var(--radius-full);
	border-color: transparent;
	background: var(--warn-soft);
	color: var(--warn);
}

button.chats-waiting:hover:not(:disabled) {
	background: var(--warn-soft);
	border-color: transparent;
}

button.chats-add {
	background: var(--surface-2);
	border-radius: var(--radius-full);
	color: var(--text);
}

/* ── Pins: big figures, the name under each ───────────────────────────────────────────────────── */

.pins {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: var(--space-3) var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.chats[data-column] .pins {
	grid-template-columns: repeat(4, minmax(0, 1fr));
}

a.pin {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-2);
	min-width: 0;
	padding: var(--space-2) var(--space-1);
	border: 1px solid transparent;
	border-radius: var(--radius);
	color: inherit;
	text-decoration: none;
}

a.pin:hover {
	background: var(--surface-2);
}

a.pin[aria-current="page"] {
	border-color: var(--agent-accent, var(--accent));
	background: color-mix(
		in srgb,
		var(--agent-accent, var(--accent)) 14%,
		var(--surface)
	);
}

.pin-picture {
	position: relative;
	display: grid;
	place-items: center;
}

.pin-name {
	max-width: 100%;
	overflow: hidden;
	font-size: var(--text-sm);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.pin-count,
.pin-star,
.pin-dot {
	position: absolute;
}

.pin-count {
	top: -0.15rem;
	right: -0.35rem;
	display: grid;
	place-items: center;
	min-width: 1.5rem;
	height: 1.5rem;
	padding: 0 0.4rem;
	border-radius: var(--radius-full);
	font-size: var(--text-xs);
	font-weight: var(--weight-bold);
}

.pin-count[data-kind="waiting"] {
	background: var(--warn);
	color: var(--bg);
}

.pin-count[data-kind="unread"] {
	background: var(--accent);
	color: var(--on-accent);
}

.pin-star {
	right: -0.25rem;
	bottom: 0;
	display: grid;
	place-items: center;
	width: 1.5rem;
	height: 1.5rem;
	border-radius: var(--radius-full);
	background: var(--warn);
	color: var(--bg);
}

.pin-dot {
	right: 0.1rem;
	bottom: 0.1rem;
	width: 0.9rem;
	height: 0.9rem;
	border-radius: var(--radius-full);
	background: var(--success);
	box-shadow: 0 0 0 3px var(--bg);
}

.pin-dot[data-home] {
	right: auto;
	left: 0.1rem;
}

/* A figure that stands free: no disc under it while the character kit loads either. */
.av-host[data-bare]:empty {
	background: transparent;
}

/* ── Folder chips: 32px tall inside a 44px hit area ───────────────────────────────────────────── */

fieldset.chips {
	display: flex;
	min-width: 0;
	border: 0;
	gap: var(--space-1);
	margin: 0 calc(var(--space-4) * -1);
	padding: 0 var(--space-4);
	overflow-x: auto;
	scrollbar-width: none;
}

.chips::-webkit-scrollbar {
	display: none;
}

button.chip {
	flex: none;
	min-height: 2.75rem;
	padding: 0 var(--space-1);
	border: 0;
	background: none;
	color: var(--text);
}

button.chip:hover:not(:disabled) {
	background: none;
	border-color: transparent;
}

.chip-face {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 2rem;
	padding: 0 var(--space-4);
	border-radius: var(--radius-full);
	background: var(--surface-2);
	white-space: nowrap;
}

button.chip[aria-pressed="true"] .chip-face {
	background: var(--accent);
	color: var(--on-accent);
}

.chip-dot {
	display: inline-block;
	flex: none;
	width: 0.5rem;
	height: 0.5rem;
	border-radius: var(--radius-full);
	background: var(--warn);
}

/* ── The list: rows with no card around them ──────────────────────────────────────────────────── */

.chat-list {
	gap: 0;
}

.room-row.chat-row {
	min-height: 4.5rem;
	padding: var(--space-3) var(--space-2);
	border: 1px solid transparent;
	border-radius: var(--radius);
	background: transparent;
	box-shadow: none;
}

.room-row.chat-row:hover {
	border-color: transparent;
	background: var(--surface-2);
	box-shadow: none;
}

.room-row.chat-row[aria-current="page"] {
	border-color: var(--agent-accent, var(--accent));
	background: color-mix(
		in srgb,
		var(--agent-accent, var(--accent)) 14%,
		var(--surface)
	);
}

.chat-row .room-row-preview {
	gap: var(--space-2);
}

.chat-row .chat-preview {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.chat-pills {
	display: flex;
	flex: none;
	gap: var(--space-1);
	margin-left: auto;
}

.chat-pill {
	display: grid;
	place-items: center;
	min-width: 1.5rem;
	height: 1.5rem;
	padding: 0 0.45rem;
	border-radius: var(--radius-full);
	font-size: var(--text-xs);
	font-weight: var(--weight-bold);
	white-space: nowrap;
}

.chat-pill[data-kind="unread"] {
	background: var(--accent);
	color: var(--on-accent);
}

.chat-pill[data-kind="waiting"] {
	background: var(--warn-soft);
	color: var(--warn);
}

.chat-pill[data-kind="threads"] {
	background: var(--surface-3);
	color: var(--muted);
	font-weight: var(--weight-medium);
}

.hidden-row {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: var(--touch);
	padding: 0 var(--space-2);
	color: var(--muted);
	text-decoration: none;
}

.hidden-row:hover {
	color: var(--text);
}

/* ── The bottom bar: the grid button and the search ───────────────────────────────────────────── */

.chats-bar {
	position: sticky;
	bottom: 0;
	display: flex;
	align-items: center;
	gap: var(--space-3);
	margin-top: auto;
	padding: var(--space-3) 0 calc(var(--space-3) + var(--safe-bottom));
	background: linear-gradient(to top, var(--bg) 75%, transparent);
}

button.chats-grid {
	flex: none;
	width: 3rem;
	min-width: 3rem;
	height: 3rem;
	border-radius: var(--radius-full);
	background: var(--surface-2);
	color: var(--text);
}

button.chats-search {
	flex: 1;
	justify-content: flex-start;
	gap: var(--space-3);
	min-height: 3rem;
	padding: 0 var(--space-4);
	border-color: transparent;
	border-radius: var(--radius-full);
	background: var(--surface-2);
	color: var(--muted);
	font-weight: normal;
}

button.chats-search:hover:not(:disabled) {
	background: var(--surface-3);
	border-color: transparent;
}

.chats-search kbd {
	margin-left: auto;
}

@media (max-width: 1023px) {
	.chats-search kbd {
		display: none;
	}
}

`;

/** Puts the chat home's styles on the page, once. */
export function installChatsHomeStyle(): void {
	installStyle("chats-home", CHATS_HOME_CSS);
	installStyle("chats-features", CHATS_FEATURES_CSS);
}
