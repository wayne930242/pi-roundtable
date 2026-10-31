import type { RoomMessage } from "../../src/api-types.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { translate as t } from "../lib/messages.ts";

// The state line of an owner's message that was sent during a turn, and the dimming of a cancelled
// one. Loaded with the first such message, as a constructed stylesheet, so the page's own stylesheet stays as small as before.
installStyle(
	"delivery-line",
	`
.delivery-line {
	margin-top: var(--space-1);
	font-size: var(--text-xs);
	color: var(--muted);
}

.message[data-mine] .delivery-line {
	text-align: end;
}

.delivery-line[data-delivery="queued"]::before {
	content: "";
	display: inline-block;
	width: 0.5em;
	height: 0.5em;
	margin-inline-end: var(--space-1);
	border-radius: var(--radius-full);
	background: currentColor;
	opacity: 0.7;
}

.message[data-delivery="cancelled"] .bubble {
	opacity: 0.55;
}

.message[data-delivery="cancelled"] .bubble .prose {
	text-decoration: line-through;
}
`,
);

/** What the line says, in the page's words. */
function lineText(delivery: NonNullable<RoomMessage["delivery"]>): string {
	switch (delivery) {
		case "steered":
			return t("Added to this turn");
		case "queued":
			return t("Queued");
		case "cancelled":
			return t("Cancelled");
	}
}

/** Where an owner's message stands when it was sent during a turn: added to the turn, waiting for its own, or cancelled. Part of the lazy chunk of the extra rows. */
export function DeliveryLine(props: { delivery: RoomMessage["delivery"] }) {
	if (!props.delivery) return null;
	return (
		<div className="delivery-line" data-delivery={props.delivery} role="status">
			{lineText(props.delivery)}
		</div>
	);
}
