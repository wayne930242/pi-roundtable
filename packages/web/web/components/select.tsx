import type { SelectHTMLAttributes } from "react";
import { installStyle } from "../lib/lazy-style.ts";
import { Icon } from "./icons.tsx";

// The style loads with the first drop-down shown, not with the page.
export const SELECT_CSS = `
/* A drop-down: the inputs' box with the one chevron of the icon set, turned to point down. */
.select {
	position: relative;
	min-width: 0;
}

.select > select {
	appearance: none;
	padding-inline-end: 2.25rem;
	text-overflow: ellipsis;
}

.select > svg {
	position: absolute;
	inset-inline-end: var(--space-3);
	top: 50%;
	translate: 0 -50%;
	rotate: 90deg;
	color: var(--muted);
	pointer-events: none;
}

/* The pill beside the breadcrumb chips: their height, shape and tint. */
.select[data-chip] > select {
	min-height: 2rem;
	padding-block: 0;
	border-color: transparent;
	border-radius: var(--radius-full);
	background: var(--surface-2);
	font-size: var(--text-sm);
}

/* A phone zooms into a control set below 16px when it takes focus; a label's smaller text is not passed on to it. */
@media (max-width: 719px), (pointer: coarse) {
	.select > select,
	.select[data-chip] > select {
		font-size: 1rem;
	}
}
`;

/**
 * The page's drop-down: the native control (so a phone opens its own picker) drawn with the
 * inputs' height, radius, border and focus ring and one chevron of the icon set, not the
 * system's inset look. `chip` is the pill that stands beside the breadcrumb chips. A list box
 * (`size` above one, or `multiple`) has no drop-down to point at and stays the native control.
 * `className` goes on the wrapper, which is what sits in the layout.
 */
export function Select({
	chip,
	className,
	...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { chip?: boolean }) {
	if ((rest.size ?? 1) > 1 || rest.multiple === true)
		return <select className={className} {...rest} />;
	installStyle("select", SELECT_CSS);
	return (
		<span
			className={className ? `select ${className}` : "select"}
			data-chip={chip || undefined}
		>
			<select {...rest} />
			<Icon name="chevron" size={16} />
		</span>
	);
}
