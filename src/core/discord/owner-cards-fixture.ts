import type { Interaction } from "discord.js";
import { CARD_PREFIX, type CardPayload } from "./owner-cards.ts";

/** The primary owner of the cards' tests. */
export const OWNER = "100000000000000001";

/** The card's JSON, where its text, custom ids, and disabled flags can be read. */
export const json = (payload: CardPayload | undefined) =>
	JSON.stringify(payload?.components.map((c) => c.toJSON()));

/** A channel, or a thread, that records the cards sent to it and every edit of them. */
export function fakeChannel(thread = false) {
	const sent: CardPayload[] = [];
	const edits: CardPayload[] = [];
	return {
		sent,
		edits,
		/** The id of the latest card sent. */
		cardId: () =>
			json(sent.at(-1)).match(new RegExp(`${CARD_PREFIX}([0-9a-f-]+):`))?.[1] ??
			"",
		channel: async () => ({
			thread,
			send: async (payload: CardPayload) => {
				sent.push(payload);
				return {
					edit: async (change: CardPayload) => {
						edits.push(change);
					},
				};
			},
		}),
	};
}

export type Kind = "button" | "select" | "modal";

/** A press of a card's control, recording how it was answered. */
export function press(
	kind: Kind,
	customId: string,
	options: {
		user?: string;
		roles?: string[];
		values?: string[];
		text?: string;
	} = {},
) {
	const replies: string[] = [];
	const updates: CardPayload[] = [];
	const modals: unknown[] = [];
	// SAFETY: the cards read only these members of an interaction.
	const interaction = {
		isButton: () => kind === "button",
		isStringSelectMenu: () => kind === "select",
		isModalSubmit: () => kind === "modal",
		isFromMessage: () => true,
		customId,
		user: { id: options.user ?? OWNER },
		member: {
			roles: { cache: new Map((options.roles ?? []).map((r) => [r, r])) },
		},
		values: options.values ?? [],
		fields: { getTextInputValue: () => options.text ?? "" },
		reply: async (answer: { content: string }) => {
			replies.push(answer.content);
		},
		update: async (payload: CardPayload) => {
			updates.push(payload);
		},
		showModal: async (modal: unknown) => {
			modals.push(modal);
		},
		deferUpdate: async () => undefined,
	} as unknown as Interaction;
	return { interaction, replies, updates, modals };
}

/** Lets a posted card settle. */
export const tick = () => Bun.sleep(1);
