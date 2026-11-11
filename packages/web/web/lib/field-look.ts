import { installStyle } from "./lazy-style.ts";

// The look every form control of `components/fields.tsx` can take: a size, a tone and a variant,
// from one stylesheet. A control with none of them set carries no attribute and installs nothing,
// so it is drawn by the page's own rules for `input`, `select` and `textarea` alone.

/** `md`, the default, is the page's control height; `sm` is a compact button's; `lg` is for a form that should stand out. */
export type FieldSize = "sm" | "md" | "lg";
/** The state a control is in. A control marked `aria-invalid` is in `danger` unless it names a tone. */
export type FieldTone = "default" | "danger" | "warn" | "success";
/** `outline`, the default, is a bordered box on the surface; `filled` is a tinted box without a border. */
export type FieldVariant = "outline" | "filled";

export interface FieldLook {
	size?: FieldSize;
	tone?: FieldTone;
	variant?: FieldVariant;
}

/** The attributes the stylesheet reads; a default is left out. */
export interface LookAttributes {
	"data-size"?: "sm" | "lg";
	"data-tone"?: "danger" | "warn" | "success";
	"data-variant"?: "filled";
}

// The style loads with the first control that is not in the default look, a time range, a radio
// group or a field note, not with the page.
export const FIELD_CSS = `
/* Tone: one colour for the border, the focus ring, the tick and the note of a state, and its soft twin for a filled box. */
input[data-tone="danger"],
select[data-tone="danger"],
textarea[data-tone="danger"],
.field-note[data-tone="danger"] {
	--field-tone: var(--danger);
	--field-soft: var(--danger-soft);
}

input[data-tone="warn"],
select[data-tone="warn"],
textarea[data-tone="warn"],
.field-note[data-tone="warn"] {
	--field-tone: var(--warn);
	--field-soft: var(--warn-soft);
}

input[data-tone="success"],
select[data-tone="success"],
textarea[data-tone="success"],
.field-note[data-tone="success"] {
	--field-tone: var(--success);
	--field-soft: var(--success-soft);
}

/* Variant: a filled box is tinted and has no border until its tone gives it one. */
input[data-variant="filled"],
select[data-variant="filled"],
textarea[data-variant="filled"] {
	border-color: transparent;
	background: var(--surface-2);
}

input[data-variant="filled"][data-tone],
select[data-variant="filled"][data-tone],
textarea[data-variant="filled"][data-tone] {
	background: var(--field-soft);
}

input[data-tone],
select[data-tone],
textarea[data-tone] {
	border-color: var(--field-tone);
	accent-color: var(--field-tone);
}

input[data-tone]:focus-visible,
select[data-tone]:focus-visible,
textarea[data-tone]:focus-visible {
	outline-color: var(--field-tone);
	border-color: var(--field-tone);
}

/* A tick box and a radio button are drawn by the browser, which colours only the ticked one. A thin halo in the tone shows it on the other too, and follows the round of a radio button, as an outline does not. */
input[type="checkbox"][data-tone],
input[type="radio"][data-tone] {
	filter: drop-shadow(0 0 0.5px var(--field-tone))
		drop-shadow(0 0 0.5px var(--field-tone))
		drop-shadow(0 0 0.5px var(--field-tone));
}

/* Size: small is a compact button's height, large is for a form that should stand out. */
input[data-size="sm"],
select[data-size="sm"],
textarea[data-size="sm"] {
	min-height: 2rem;
	padding-block: var(--space-1);
	padding-inline-start: var(--space-2);
	font-size: var(--text-sm);
}

input[data-size="sm"],
textarea[data-size="sm"] {
	padding-inline-end: var(--space-2);
}

input[data-size="lg"],
select[data-size="lg"],
textarea[data-size="lg"] {
	min-height: 3rem;
	padding-inline-start: var(--space-4);
	font-size: var(--text-md);
}

input[data-size="lg"],
textarea[data-size="lg"] {
	padding-inline-end: var(--space-4);
}

input[type="checkbox"][data-size="sm"],
input[type="radio"][data-size="sm"] {
	width: 1rem;
	height: 1rem;
	min-height: 0;
}

input[type="checkbox"][data-size="lg"],
input[type="radio"][data-size="lg"] {
	width: 1.35rem;
	height: 1.35rem;
	min-height: 0;
}

/* A phone zooms into a control set below 16px when it takes focus, at any size. */
@media (max-width: 719px), (pointer: coarse) {
	input[data-size="sm"],
	select[data-size="sm"],
	textarea[data-size="sm"] {
		font-size: 1rem;
	}
}

/* The words under a field: a hint, or what is wrong with it, in the field's tone. */
.field-note {
	margin: 0;
	font-size: var(--text-sm);
	color: var(--muted);
}

.field-note[data-tone] {
	color: var(--field-tone);
}

.field-note[data-size="sm"] {
	font-size: var(--text-xs);
}

.field-note[data-size="lg"] {
	font-size: var(--text-base);
}

/* A span of the day: two drop-downs under their words, and the zone on the line of the drop-downs. */
.time-range {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: 0 var(--space-3);
}

/* A drop-down is as wide as a time needs and no wider than 7.5rem; the row wraps only when the zone's name is long. */
.time-range > label {
	flex: 1 1 5.75rem;
	max-width: 7.5rem;
}

/* As tall as a drop-down, so the zone reads level with the two times and not with the words above them. */
.time-range-zone {
	display: flex;
	align-items: center;
	min-height: 2.5rem;
}

.time-range[data-size="sm"] .time-range-zone {
	min-height: 2rem;
}

.time-range[data-size="lg"] .time-range-zone {
	min-height: 3rem;
}

/* A short list to pick one of. The rows touch: each is as tall as a target must be, so a gap between them only spreads the list out. */
.radio-group {
	display: flex;
	flex-direction: column;
}

.radio-group > label {
	flex-direction: row;
	align-items: center;
	gap: var(--space-2);
	min-height: 2rem;
}

.radio-group input {
	flex: none;
	margin: 0;
}

.radio-group[data-size="sm"] > label {
	min-height: 1.75rem;
	font-size: var(--text-xs);
}

.radio-group[data-size="lg"] > label {
	min-height: 2.5rem;
	font-size: var(--text-base);
}

/* On a phone a row is a touch target at every size, and the zone follows the drop-downs' height there. */
@media (max-width: 719px), (pointer: coarse) {
	.time-range-zone,
	.radio-group > label,
	.radio-group[data-size] > label {
		min-height: var(--touch);
	}
}

/* A short row of choices of which one holds, as one bar. Written with :where so a caller's own rule for one bar (the round table's switch) wins at any load order. */
:where(.segmented) {
	display: inline-flex;
	gap: 2px;
	padding: 3px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface-2);
}

:where(.segmented[data-wide]) {
	display: flex;
}

:where(.segmented[data-wide]) label {
	flex: 1;
}

:where(.segmented) label {
	position: relative;
	flex-direction: row;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	min-height: 2.25rem;
	padding: 0 var(--space-3);
	border-radius: calc(var(--radius) - 3px);
	color: var(--muted);
	font-weight: var(--weight-medium);
	cursor: pointer;
	transition:
		background-color var(--dur) var(--ease-out),
		color var(--dur) var(--ease-out);
}

:where(.segmented) label[data-checked="true"] {
	background: var(--surface);
	color: var(--text);
	box-shadow:
		var(--shadow-1),
		inset 0 0 0 1px var(--border-strong);
}

:where(.segmented) input {
	position: absolute;
	opacity: 0;
	inset: 0;
	width: 100%;
	height: 100%;
	cursor: pointer;
}

:where(.segmented) label:has(:focus-visible) {
	outline: 2px solid var(--accent);
}

.segmented[data-tone="danger"] {
	--field-tone: var(--danger);
}

.segmented[data-tone="warn"] {
	--field-tone: var(--warn);
}

.segmented[data-tone="success"] {
	--field-tone: var(--success);
}

.segmented[data-tone] {
	border-color: var(--field-tone);
}

.segmented[data-tone] label:has(:focus-visible) {
	outline-color: var(--field-tone);
}

.segmented[data-size="sm"] label {
	min-height: 1.75rem;
	font-size: var(--text-xs);
}

.segmented[data-size="lg"] label {
	min-height: 2.75rem;
	font-size: var(--text-md);
}

/* On a phone a choice is a touch target at every size. */
@media (max-width: 719px), (pointer: coarse) {
	:where(.segmented) label,
	.segmented[data-size] label {
		min-height: var(--touch);
	}
}
`;

/** Puts the stylesheet of the looks, the time range, the radio group and the field note in the page, once. */
export function installFieldStyle(): void {
	installStyle("field-look", FIELD_CSS);
}

/** What `aria-invalid` may hold; anything but false marks the control invalid. */
export type AriaInvalid =
	| boolean
	| "true"
	| "false"
	| "grammar"
	| "spelling"
	| undefined;

/**
 * The look as the attributes the stylesheet reads, with the stylesheet installed when there is one
 * to read. `invalid` is the control's `aria-invalid`, which puts it in `danger` when no tone is named.
 */
export function lookAttributes(
	look: FieldLook,
	invalid?: AriaInvalid,
): LookAttributes {
	const wrong =
		invalid !== undefined && invalid !== false && invalid !== "false";
	const tone = look.tone ?? (wrong ? "danger" : "default");
	const attributes: LookAttributes = {
		...(look.size === "sm" || look.size === "lg"
			? { "data-size": look.size }
			: {}),
		...(tone !== "default" ? { "data-tone": tone } : {}),
		...(look.variant === "filled" ? { "data-variant": "filled" } : {}),
	};
	if (Object.keys(attributes).length > 0) installFieldStyle();
	return attributes;
}
