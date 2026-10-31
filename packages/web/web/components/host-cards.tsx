import { useState } from "react";
import { noCards, useHost } from "../lib/host-state.ts";
import { useMedia } from "../lib/media.ts";
import { plural, translate as t } from "../lib/messages.ts";
import type { RunAction } from "./host-actions.tsx";
import { HostCard, isOpenCard } from "./host-card.tsx";
import { Icon } from "./icons.tsx";

/**
 * The cards that still ask for something, open; the rest folded under them. On a phone the strip
 * starts folded to one line, so the conversation keeps the screen.
 */
export function HostCards(props: {
	room: string;
	run: (card: string) => RunAction;
}) {
	const cards = useHost((state) => state.cards[props.room] ?? noCards);
	const wide = useMedia("(min-width: 720px) and (min-height: 760px)");
	const [asked, setAsked] = useState<boolean>();
	if (cards.length === 0) return null;
	const live = cards.filter(
		(card) => isOpenCard(card) || card.state === "working",
	);
	const earlier = cards.filter((card) => !live.includes(card));
	const shown = asked ?? (wide && live.length > 0);
	const first = live[0];
	return (
		<div className="host-cards" data-open={shown || undefined}>
			<button
				type="button"
				className="host-cards-toggle"
				aria-expanded={shown}
				onClick={() => setAsked(!shown)}
			>
				<Icon name="chevron" size={14} />
				{first ? (
					<span>
						<strong>
							{plural(
								live.length,
								"{count} card waiting",
								"{count} cards waiting",
							)}
						</strong>
						{`: ${first.title}`}
					</span>
				) : (
					<span>{t("Earlier cards ({count})", { count: earlier.length })}</span>
				)}
			</button>
			{shown ? (
				<div className="host-cards-body">
					{live.map((card) => (
						<HostCard key={card.id} card={card} run={props.run(card.id)} />
					))}
					{earlier.length ? (
						<details className="host-cards-older">
							<summary>
								{t("Earlier cards ({count})", { count: earlier.length })}
							</summary>
							{earlier.map((card) => (
								<HostCard key={card.id} card={card} run={props.run(card.id)} />
							))}
						</details>
					) : null}
				</div>
			) : null}
		</div>
	);
}
