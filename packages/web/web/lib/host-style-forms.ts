/** The styles of a host page's forms and lists. */
export const HOST_FORM_CSS = `.host-form {
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
