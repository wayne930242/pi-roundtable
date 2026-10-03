import { DrawingError } from "../errors.ts";
import type { Random } from "../random.ts";
import { type Card, type Deck, groupsOf } from "./deck.ts";

export interface DrawnCard extends Card {
	reversed: boolean;
}

export interface DrawParams {
	deck: Deck;
	count: number;
	/** Draw only from the cards of this group. */
	group?: string | undefined;
	exclude?: readonly string[] | undefined;
	/** Whether cards may come up reversed; the deck's own default when absent. */
	allowReversed?: boolean | undefined;
	random: Random;
	/** Ignore exclusions that are not cards of the deck, instead of refusing them. */
	ignoreUnknownExclusions?: boolean | undefined;
}

/** Draws from the whole deck minus the exclusions; there is no persistent deck between draws. */
export function drawCards(params: DrawParams): DrawnCard[] {
	const {
		deck,
		count,
		group,
		exclude,
		allowReversed,
		random,
		ignoreUnknownExclusions,
	} = params;
	if (!Number.isInteger(count) || count < 1)
		throw new DrawingError(
			`count must be a whole number of at least 1; got ${count}.`,
		);
	if (group !== undefined && !groupsOf(deck).includes(group))
		throw new DrawingError(
			`Deck ${deck.id} has no group ${JSON.stringify(group)}. ${
				groupsOf(deck).length > 0
					? `Its groups are ${groupsOf(deck).join(", ")}.`
					: "It has no groups; omit group."
			}`,
		);
	const known = new Set(deck.cards.map((card) => card.id));
	const excluded = new Set(exclude ?? []);
	for (const id of excluded)
		if (!known.has(id) && !ignoreUnknownExclusions)
			throw new DrawingError(
				`exclude names ${JSON.stringify(id)}, which is not a card of deck ${deck.id}. Use the card ids the deck lists.`,
			);
	const pool = deck.cards.filter(
		(card) =>
			!excluded.has(card.id) && (group === undefined || card.group === group),
	);
	if (count > pool.length)
		throw new DrawingError(
			`Cannot draw ${count} cards: only ${pool.length} are available in deck ${deck.id}${group ? ` group ${group}` : ""} with ${excluded.size} excluded.`,
		);

	// Fisher–Yates on the copy, then take the first `count`.
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const a = pool[i];
		const b = pool[j];
		if (a && b) {
			pool[i] = b;
			pool[j] = a;
		}
	}
	const reversible = allowReversed ?? deck.reversals;
	return pool.slice(0, count).map((card) => ({
		...card,
		reversed: reversible ? random() < 0.5 : false,
	}));
}
