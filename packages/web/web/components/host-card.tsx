import type { HostCardView } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import { HostActions, type RunAction } from "./host-actions.tsx";
import { HostMarkdown } from "./host-markdown.tsx";
import { Badge } from "./states.tsx";

/** The card's state in words; an open card says nothing. */
function stateText(state: HostCardView["state"]): string {
	switch (state ?? "open") {
		case "working":
			return t("Working…");
		case "done":
			return t("Done");
		case "superseded":
			return t("Replaced");
		case "expired":
			return t("Expired");
		default:
			return "";
	}
}

/** Whether the card is still asking for something: only an open card has buttons. */
export const isOpenCard = (card: Pick<HostCardView, "state">): boolean =>
	(card.state ?? "open") === "open";

/**
 * A card the host put in its room (or on a page): a title, text, links, and, while it is open, the
 * buttons this person may press. Once it is working, done, replaced or expired it has none.
 */
export function HostCard(props: {
	card: Pick<HostCardView, "title" | "body" | "tone" | "state" | "links" | "buttons">;
	run: RunAction;
}) {
	const { card } = props;
	const state = stateText(card.state);
	return (
		<article
			className="host-card"
			data-tone={card.tone ?? "note"}
			data-state={card.state ?? "open"}
		>
			<header>
				<h3>{card.title}</h3>
				{state ? (
					<Badge tone={card.state === "working" ? "busy" : "plain"}>
						{state}
					</Badge>
				) : null}
			</header>
			{card.body ? <HostMarkdown source={card.body} /> : null}
			{card.links?.length ? (
				<div className="host-card-links">
					{card.links.map((link) => (
						<a
							key={`${link.url}`}
							href={link.url}
							{...(link.url.startsWith("/")
								? {}
								: { target: "_blank", rel: "noreferrer noopener" })}
						>
							{link.label}
						</a>
					))}
				</div>
			) : null}
			{isOpenCard(card) && card.buttons?.length ? (
				<HostActions actions={card.buttons} run={props.run} />
			) : null}
		</article>
	);
}
