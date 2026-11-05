// What a room's row on the rooms page uncovers as it is swiped to the left: the modes the swipe turns
// it to. It is made by the swipe, which loads after the list, so neither it nor its style is in what
// the page loads first. The menu's mode items are the way a reader is told of.

import { createRoot, type Root } from "react-dom/client";
import type { RoomMode } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { translate as t } from "./messages.ts";

type Modes = Pick<RoomMode, "yolo" | "longRunning">;

const MODE_REVEAL_CSS = `
li:has(> .mode-reveal) {
	position: relative;
}

li:has(> .mode-reveal[data-shown]) {
	overflow-x: clip;
}

.mode-reveal {
	position: absolute;
	right: 0;
	left: 0;
	display: flex;
	visibility: hidden;
	opacity: 0;
	pointer-events: none;
	/* It fades as the row springs back over it. */
	transition:
		opacity var(--dur) var(--ease-out),
		visibility 0s linear var(--dur);
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-2);
	padding-right: var(--space-4);
	border-radius: var(--radius-lg);
	background: var(--surface-2);
	color: var(--muted);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
}

.mode-reveal[data-shown] {
	visibility: visible;
	opacity: 1;
	transition: none;
}

.mode-reveal svg {
	transition:
		transform var(--dur-fast) var(--ease-out),
		color var(--dur-fast) var(--ease-out);
}

/* Pulled far enough: letting go turns the modes. */
.mode-reveal[data-armed] {
	color: var(--text);
}

.mode-reveal[data-armed] svg {
	color: var(--yolo);
	transform: scale(1.1);
}

.mode-reveal[data-armed] svg + svg {
	color: var(--long);
}

.mode-reveal[data-armed][data-to="off"] svg {
	color: inherit;
}
`;

/** What the reveal shows: the modes the swipe turns to. */
export const revealKind = (to: Modes): "yolo" | "both" | "off" =>
	to.longRunning ? "both" : to.yolo ? "yolo" : "off";

/**
 * Puts the style in the document once. Not `installStyle`: the lazy-style chunk would be one more
 * entry in the preload map the first load carries, past its budget.
 */
function styleOnce(): void {
	if (document.querySelector("style[data-mode-reveal]")) return;
	const style = document.createElement("style");
	style.dataset.modeReveal = "";
	style.textContent = MODE_REVEAL_CSS;
	document.head.append(style);
}

const roots = new WeakMap<HTMLElement, { root: Root; kind: string }>();

function Shown(props: { kind: "yolo" | "both" | "off" }) {
	if (props.kind === "off")
		return (
			<>
				<Icon name="close" size={16} />
				{t("Off")}
			</>
		);
	return (
		<>
			<Icon name="bolt" size={16} />
			{props.kind === "both" ? <Icon name="timer" size={16} /> : null}
		</>
	);
}

/** The reveal beside `row`, made the first time, showing the modes `to`. */
export function modeReveal(row: HTMLElement, to: Modes): HTMLElement | null {
	const item = row.parentElement;
	if (!item) return null;
	styleOnce();
	let reveal = item.querySelector<HTMLElement>(":scope > .mode-reveal");
	if (!reveal) {
		reveal = document.createElement("span");
		reveal.className = "mode-reveal";
		reveal.setAttribute("aria-hidden", "true");
		item.prepend(reveal);
	}
	const kind = revealKind(to);
	const drawn = roots.get(reveal) ?? { root: createRoot(reveal), kind: "" };
	roots.set(reveal, drawn);
	if (drawn.kind !== kind) {
		drawn.kind = kind;
		reveal.dataset.to = kind;
		drawn.root.render(<Shown kind={kind} />);
	}
	return reveal;
}
