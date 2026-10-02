import { Type } from "typebox";
import type { Deck } from "../cards/deck.ts";
import { groupsOf } from "../cards/deck.ts";
import { drawCards } from "../cards/draw.ts";
import {
	autoLayout,
	checkSpread,
	MAX_GRID,
	renderSpread,
	type SpreadPosition,
} from "../cards/spread.ts";
import { DrawingError } from "../errors.ts";
import type { Random } from "../random.ts";
import {
	type ImageToolEnv,
	imageTool,
	literals,
	strictObject,
} from "./image-tool.ts";

const MAX_DRAW = 100;

function describeDeck(deck: Deck): string {
	const groups = groupsOf(deck);
	return `${deck.id}: ${deck.name}, ${deck.cards.length} cards${
		groups.length > 0 ? ` (groups: ${groups.join(", ")})` : ""
	}${deck.reversals ? "" : ", upright by default"}`;
}

/** `draw_cards`: draws from one of the operator's decks and attaches a picture of the spread to the reply. */
export function drawCardsTool(
	decks: readonly Deck[],
	env: ImageToolEnv,
	random: Random,
) {
	const [first, ...rest] = decks;
	if (!first) throw new DrawingError("draw_cards needs at least one deck.");
	return imageTool(
		{
			name: "draw_cards",
			description: `Draw cards from a full, freshly shuffled deck and attach a picture of the spread to your reply. Each draw is independent; pass exclude to leave cards out. Read the returned cards, not your own guess. Decks: ${decks.map(describeDeck).join("; ")}.`,
			parameters: strictObject({
				deck: literals(
					[first, ...rest].map((deck) => deck.id),
					"The deck to draw from.",
				),
				count: Type.Integer({ minimum: 1, maximum: MAX_DRAW }),
				group: Type.Optional(
					Type.String({
						description:
							"Draw only from the cards of this group of the deck, when the deck has groups.",
					}),
				),
				exclude: Type.Optional(
					Type.Array(Type.String(), {
						description: "Card ids to leave out, as the deck lists them.",
					}),
				),
				allow_reversed: Type.Optional(
					Type.Boolean({
						description:
							"Whether cards may come up reversed; the deck's own default when omitted.",
					}),
				),
				spread: Type.Optional(
					Type.Array(
						strictObject({
							row: Type.Integer({ minimum: 0, maximum: MAX_GRID }),
							col: Type.Integer({ minimum: 0, maximum: MAX_GRID }),
							label: Type.String({
								description: "What the position means, such as Past.",
							}),
						}),
						{
							description:
								"One position per card for a named spread; omit for plain rows.",
						},
					),
				),
				question: Type.Optional(
					Type.String({ description: "The question, shown on the picture." }),
				),
			}),
			draw: async (args) => {
				const deck = decks.find((candidate) => candidate.id === args.deck);
				if (!deck)
					throw new DrawingError(
						`Unknown deck ${JSON.stringify(args.deck)}. Use ${decks.map((d) => d.id).join(", ")}.`,
					);
				const positions: SpreadPosition[] =
					args.spread ?? autoLayout(args.count);
				// Checked before the draw, so a refused spread leaves the random source where it was.
				checkSpread(positions, args.count);
				const cards = drawCards({
					deck,
					count: args.count,
					group: args.group,
					exclude: args.exclude,
					allowReversed: args.allow_reversed,
					random,
				});
				const image = await renderSpread(deck, cards, positions, {
					title: deck.name,
					subtitle:
						args.question ??
						`${cards.length} card${cards.length === 1 ? "" : "s"}`,
				});
				const lines = cards.map((card, i) => {
					const label = positions[i]?.label ? `${positions[i]?.label}: ` : "";
					return `${i + 1}. ${label}${card.name}${card.reversed ? " (reversed)" : ""} [id: ${card.id}]`;
				});
				return {
					stem: "cards",
					image,
					text: `Drew ${cards.length} from ${deck.id}; the spread picture is attached to your reply as {file}.\n${lines.join("\n")}`,
				};
			},
		},
		env,
	);
}
