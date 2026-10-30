// The styles only host rooms, host pages, the read marks and the unread count need. They load with
// the first of those, as a constructed stylesheet, so the page's own stylesheet (which every visit
// downloads before it draws) stays as small as before the host rooms.

export const HOST_CSS = `
.hpic {
	flex: none;
	display: inline-grid;
	place-items: center;
	overflow: hidden;
	border-radius: var(--radius-full);
	background: var(--surface-3);
	color: #fff;
	font-weight: var(--weight-bold);
	line-height: 1;
	user-select: none;
}

.hpic > img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

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

.seen-toggle .hpic + .hpic {
	margin-left: -0.35rem;
	box-shadow: 0 0 0 1.5px var(--bg);
}

.seen-names {
	flex-basis: 100%;
	text-align: right;
}

.host-head-fields {
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

.host-form {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.host-field {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-width: 0;
}

.host-field > label,
.host-field > legend {
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
}

.host-field .hint {
	color: var(--muted);
	font-size: var(--text-xs);
}

.host-field .field-error {
	color: var(--danger);
	font-size: var(--text-sm);
}

.host-field fieldset {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	margin: 0;
	padding: 0;
	border: 0;
	max-height: 14rem;
	overflow-y: auto;
}

.host-field fieldset label {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: var(--touch);
}

.host-field select[size] {
	min-height: 9rem;
}

.host-list {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.host-list > li {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	padding: var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	background: var(--surface);
}

.host-list-main {
	display: flex;
	flex: 1;
	flex-direction: column;
	min-width: 0;
}

.host-list-main > a,
.host-list-main > strong {
	color: var(--text);
	font-weight: var(--weight-medium);
	text-decoration: none;
	overflow-wrap: anywhere;
}

.host-list-main > span {
	color: var(--muted);
	font-size: var(--text-sm);
}

.attention-dot {
	flex: none;
	width: 0.6rem;
	height: 0.6rem;
	border-radius: var(--radius-full);
	background: var(--danger);
}

.kind-filter {
	width: 100%;
}

.kind-row-picture {
	position: relative;
	display: inline-flex;
}

.kind-row-picture .attention-dot {
	position: absolute;
	top: -1px;
	right: -1px;
	box-shadow: 0 0 0 2px var(--surface);
}
`;

let installed = false;

/** Adds the host rooms' styles to the page, once. */
export function installHostStyle(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	if (
		typeof CSSStyleSheet !== "undefined" &&
		"adoptedStyleSheets" in Document.prototype
	) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(HOST_CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
			return;
		} catch {
			// A browser that cannot adopt a sheet takes a style element.
		}
	}
	const style = document.createElement("style");
	style.textContent = HOST_CSS;
	document.head.append(style);
}
