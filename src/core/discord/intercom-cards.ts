import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Interaction,
	MessageFlags,
} from "discord.js";
import type { IntercomCard } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";
import { intercomHeading, intercomSummary } from "../presentation/intercom.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import type { InteractionModule } from "./interaction-module.ts";

/** The custom id of a card's open button starts with this; the text's id follows. */
export const INTERCOM_BUTTON_PREFIX = "roundtable:intercom:";
/** The most messages an opened card's text takes; a longer text comes as one file. */
const MAX_PARTS = 5;

/** The whole texts of the cards, by the id their open button carries; `CardCopies` keeps them. */
export interface IntercomTexts {
	remember(id: string, text: string): void;
	recall(id: string): string | undefined;
}

/**
 * A card's message: one line of small text, its heading and summary, and an open button when the
 * summary leaves part of the text out and the text was kept under `id`.
 */
export function intercomMessage(card: IntercomCard, id: string | undefined) {
	const line = messages().intercomLine(
		intercomHeading(card),
		intercomSummary(card.text),
	);
	return {
		content: `-# ${line}`,
		allowedMentions: { parse: [] as never[] },
		...(id === undefined
			? {}
			: {
					components: [
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder()
								.setCustomId(`${INTERCOM_BUTTON_PREFIX}${id}`)
								.setLabel(messages().intercomExpand)
								.setStyle(ButtonStyle.Secondary),
						),
					],
					withComponents: true,
				}),
	};
}

/**
 * What a press of the open button answers, seen only by whoever pressed: the whole text in
 * messages within Discord's limit, or one file when it would take more than `MAX_PARTS`.
 */
export function intercomReplies(text: string) {
	const flags = MessageFlags.Ephemeral as const;
	const allowedMentions = { parse: [] as never[] };
	const parts = splitReply(text);
	if (parts.length <= MAX_PARTS)
		return parts.map((content) => ({ content, flags, allowedMentions }));
	return [
		{
			content: messages().cardCopyFile,
			files: [
				new AttachmentBuilder(Buffer.from(text, "utf8"), {
					name: "message.md",
				}),
			],
			flags,
			allowedMentions,
		},
	];
}

/**
 * Answers a press of a card's open button with the card's whole text, to whoever pressed; a text
 * no longer kept is said to be gone.
 */
export function intercomButtonModule(
	texts: Pick<IntercomTexts, "recall">,
): InteractionModule {
	return {
		commands: () => [],
		handle: async (interaction: Interaction) => {
			if (
				!interaction.isButton() ||
				!interaction.customId.startsWith(INTERCOM_BUTTON_PREFIX)
			)
				return false;
			const text = texts.recall(
				interaction.customId.slice(INTERCOM_BUTTON_PREFIX.length),
			);
			if (!text) {
				await interaction.reply({
					content: messages().intercomGone,
					flags: MessageFlags.Ephemeral,
				});
				return true;
			}
			const [first, ...rest] = intercomReplies(text);
			await interaction.reply(first ?? { content: text });
			for (const part of rest) await interaction.followUp(part);
			return true;
		},
	};
}
