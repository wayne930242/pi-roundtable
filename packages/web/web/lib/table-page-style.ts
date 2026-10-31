// The styles of the scene's folding dialogue box and of a council's header and display mode. They
// load with the box and the council view, as constructed stylesheets, so the page's own stylesheet
// (which every visit downloads before it draws) stays small.

import { installStyle } from "./lazy-style.ts";

export const DIALOGUE_FOLD_CSS = `
/* The box's fold button says what it does, in words beside its chevron. */
.scene-collapse {
	width: auto;
	flex: none;
	gap: var(--space-1);
	padding-inline: var(--space-2);
	font-size: var(--text-xs);
}
.scene-collapse span {
	white-space: nowrap;
}
/* Folded, the box is one bar: who speaks, the start of their newest line, and the button that opens it. */
.scene-bar {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: var(--touch);
	padding: var(--space-1) var(--space-1) var(--space-1) var(--space-2);
	cursor: pointer;
}
.scene-bar .scene-chip {
	width: 2rem;
	height: 2rem;
	margin: 0;
	border-width: 2px;
	flex: none;
}
.scene-bar-name {
	flex: 0 1 auto;
	min-width: 3ch;
	max-width: 35%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.scene-bar-preview {
	flex: 1 1 0;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--muted);
	font-size: var(--text-sm);
}
.scene-bar-asking {
	flex: none;
	padding: 0 var(--space-2);
	border-radius: var(--radius-full);
	background: color-mix(in srgb, var(--accent) 16%, transparent);
	font-size: var(--text-xs);
	white-space: nowrap;
}
.scene-composer[hidden] {
	display: none;
}

/* On a phone the tab's tools are narrow, but the fold button keeps its words. */
@media (max-width: 719px) {
	.scene-tools .scene-collapse,
	.scene-bar .scene-collapse {
		width: auto;
		min-width: 0;
		padding-inline: var(--space-1);
	}
}
/* Phones held upright: folded, the box is only its bar and the scene takes the rest. */
@media (max-width: 719px) and (orientation: portrait) {
	.table-frame[data-focused][data-folded] {
		grid-template-rows: minmax(0, 1fr) auto;
	}
}
`;

export const TABLE_PAGE_CSS = `
/* The header's tools wrap under the title on a narrow screen rather than overflow it. */
.table-tools {
	flex-wrap: wrap;
	justify-content: flex-end;
}
/* The switch between the scene and the chat: two short choices that sit beside the council chip. */
.table-mode {
	flex: none;
	margin: 0;
}
.table-mode label {
	min-height: 2rem;
	padding: 0 var(--space-2);
	font-size: var(--text-sm);
	white-space: nowrap;
}
/* A council's header: on a phone its tools take a row of their own under the title. */
@media (max-width: 719px) {
	.council-head {
		flex-wrap: wrap;
	}
	.council-head .table-tools {
		order: 3;
		flex-basis: 100%;
		min-width: 0;
	}
	.council-head .council-chip {
		flex: 1 1 0;
		min-width: 0;
	}
}
/* The council's messages as a chat fill the view under its header, like a room's own list. */
.table-chat {
	position: relative;
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
}
`;

export const installDialogueFoldStyle = (): void =>
	installStyle("dialogue-fold", DIALOGUE_FOLD_CSS);

export const installTablePageStyle = (): void =>
	installStyle("table-page", TABLE_PAGE_CSS);
