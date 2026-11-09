/** The styles of a host page: its head fields, banner, actions and card list. */
export const HOST_PAGE_CSS = `.host-head-fields {
	display: flex;
	flex-wrap: wrap;
	gap: 0 var(--space-4);
	margin: 0;
	padding: var(--space-1) var(--space-4);
	border-bottom: 1px solid var(--border);
	background: var(--surface);
	font-size: var(--text-xs);
}

.host-head-fields > div {
	display: flex;
	gap: var(--space-2);
	min-width: 0;
}

.host-head-fields dt {
	color: var(--muted);
}

.host-head-fields dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.host-banner {
	margin: 0;
	padding: var(--space-1) var(--space-4);
	border-bottom: 1px solid var(--border);
	font-size: var(--text-sm);
}

.host-banner[data-tone="warn"] {
	background: var(--warn-soft);
}

.host-banner[data-tone="risk"] {
	background: var(--danger-soft);
	color: var(--danger);
}

.host-actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.host-actions.bar {
	flex-wrap: nowrap;
	padding: var(--space-2) var(--space-4);
	border-bottom: 1px solid var(--border);
	overflow-x: auto;
}

.host-actions.bar > button {
	flex: none;
	min-height: 2.25rem;
	padding: 0 var(--space-3);
	font-size: var(--text-sm);
}

.host-cards {
	display: flex;
	flex-direction: column;
	border-top: 1px solid var(--border);
	background: var(--surface-2);
}

.host-cards-toggle {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 2.5rem;
	padding: 0 var(--space-4);
	border: 0;
	border-radius: 0;
	background: none;
	color: var(--text);
	font: inherit;
	font-size: var(--text-sm);
	text-align: left;
	overflow: hidden;
}

.host-cards-toggle:hover:not(:disabled) {
	background: var(--surface-2);
}

.host-cards-toggle > span {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.host-cards-toggle > svg {
	flex: none;
	transition: transform var(--dur-fast) var(--ease-out);
}

.host-cards[data-open] .host-cards-toggle > svg {
	transform: rotate(90deg);
}

.host-cards-body {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	max-height: min(16rem, 34vh);
	padding: 0 var(--space-4) var(--space-3);
	overflow-y: auto;
}

.host-card {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-3);
	border: 1px solid var(--border);
	border-left-width: 4px;
	border-radius: var(--radius-lg);
	background: var(--surface);
}

.host-card[data-tone="ok"] {
	border-left-color: var(--success);
}

.host-card[data-tone="warn"] {
	border-left-color: var(--warn);
}

.host-card[data-tone="risk"] {
	border-left-color: var(--danger);
}

.host-card[data-tone="note"] {
	border-left-color: var(--accent);
}

.host-card[data-state="done"],
.host-card[data-state="superseded"],
.host-card[data-state="expired"] {
	opacity: 0.7;
}

.host-card header {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.host-card h3 {
	flex: 1;
	margin: 0;
	font-size: var(--text-md);
}

.host-card-links {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-4);
	font-size: var(--text-sm);
}

.host-cards-older {
	font-size: var(--text-sm);
	color: var(--muted);
}

.host-cards-older > summary {
	cursor: pointer;
}

.section-icon {
	margin-right: var(--space-1);
	vertical-align: -2px;
}

`;
