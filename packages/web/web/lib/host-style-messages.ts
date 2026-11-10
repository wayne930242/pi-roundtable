/** The styles of a host room's messages: pictures, marks, bubbles, notices and the read line. */
export const HOST_MESSAGE_CSS = `
.unread-mark {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 1.35rem;
	height: 1.35rem;
	padding: 0 0.4rem;
	border-radius: var(--radius-full);
	background: var(--accent);
	color: var(--on-accent);
	font-size: var(--text-xs);
	font-weight: var(--weight-bold);
	font-variant-numeric: tabular-nums;
}

.room-row-top .unread-mark {
	margin-left: auto;
}

.room-row-top .unread-mark + .room-row-time {
	margin-left: 0;
}

.switcher-name .unread-mark {
	margin-left: auto;
}

.plain {
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.label-chip {
	padding: 0 var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-3);
	color: var(--muted);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
}

.message[data-author="assistant"] .bubble {
	border-color: transparent;
	background: var(--accent-soft);
}

.message[data-author="member"]:not([data-mine]) .bubble {
	background: var(--surface-2);
}

.message .bubble {
	transition: box-shadow var(--dur) var(--ease-out);
}

/* A message not seen yet: a soft ring and glow in the accent, uniform on every side, gone once seen.
   The row is drawn in full so its paint containment does not cut the glow off at the bubble's edge. */
.message[data-unread] {
	content-visibility: visible;
}

.message[data-unread] .bubble {
	box-shadow:
		0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent),
		0 0 14px color-mix(in srgb, var(--accent) 38%, transparent);
}

.message[data-highlight] .bubble {
	animation: host-highlight 2.4s var(--ease-out) both;
}

@keyframes host-highlight {
	0%, 60% {
		box-shadow: 0 0 0 3px var(--accent);
	}
}

.message-edited,
.message-expired {
	margin: var(--space-1) 0 0;
	color: var(--muted);
	font-size: var(--text-xs);
}

.host-notice {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	margin: var(--space-3) auto;
	max-width: min(36rem, 92%);
	padding: var(--space-2) var(--space-3);
	border: 1px dashed var(--border-strong);
	border-radius: var(--radius-lg);
	background: var(--surface-2);
	color: var(--muted);
	font-size: var(--text-sm);
}

.host-notice[data-highlight] {
	animation: host-highlight 2.4s var(--ease-out) both;
}

.host-notice > svg {
	flex: none;
	margin-top: 0.2rem;
}

.host-notice time {
	margin-left: auto;
	padding-left: var(--space-2);
	font-size: var(--text-xs);
	white-space: nowrap;
}

.new-divider {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	margin: var(--space-3) 0 var(--space-1);
	color: var(--accent);
	font-size: var(--text-xs);
	font-weight: var(--weight-bold);
}

.new-divider::before,
.new-divider::after {
	content: "";
	flex: 1;
	height: 1px;
	background: var(--accent);
	opacity: 0.55;
}

.seen {
	display: flex;
	justify-content: flex-end;
	flex-wrap: wrap;
	gap: var(--space-2);
	padding: 0 var(--space-1);
	color: var(--muted);
	font-size: var(--text-xs);
}

.seen-toggle {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-height: 0;
	padding: 0 var(--space-1);
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	cursor: pointer;
}

.seen-toggle:hover:not(:disabled) {
	background: none;
}

.seen-toggle .hpic + .hpic {
	margin-left: -0.35rem;
	box-shadow: 0 0 0 1.5px var(--bg);
}

.seen-names {
	flex-basis: 100%;
	text-align: right;
}

`;
