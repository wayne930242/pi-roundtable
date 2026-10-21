import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	LabelBuilder,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { messages } from "../i18n/index.ts";
import {
	type OwnerAnswer,
	type OwnerQuestion,
	withdrawalNote,
} from "../interactions/prompts.ts";
import { type ownerPanel, plain } from "./owner-panel.ts";
import { clip } from "./utf16.ts";

/** The prefix of every card control's custom id. */
export const CARD_PREFIX = "roundtable:card:";
/** The menu value of "Other…". */
export const OTHER = "other";
/** The answer form's text field. */
export const TEXT_FIELD = "text";

export type Rows = NonNullable<Parameters<typeof ownerPanel>[0]["rows"]>;

/** A question's controls: a menu of its options, or a button that opens the answer form. */
export function askRows(
	id: string,
	question: OwnerQuestion,
	disabled: boolean,
): Rows {
	if (question.options.length === 0)
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${CARD_PREFIX}${id}:write`)
					.setLabel(messages().cardAnswerLabel)
					.setStyle(ButtonStyle.Primary)
					.setDisabled(disabled),
			),
		];
	// Discord menus take 25 options. With 24 or fewer, "Other…" is the last entry; with 25 it
	// would push one out, so the menu keeps all of them and "Answer…" opens the form instead.
	const roomForOther = question.allowOther && question.options.length < 25;
	const options: { label: string; value: string; description?: string }[] =
		question.options.map((option, i) => ({
			label: clip(option.label, 100),
			value: String(i),
			...(option.description
				? { description: clip(option.description, 100) }
				: {}),
		}));
	if (roomForOther)
		options.push({
			label: messages().cardOtherLabel,
			value: OTHER,
			description: messages().cardOtherDescription,
		});
	const menu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`${CARD_PREFIX}${id}:pick`)
			.setPlaceholder(
				question.multi
					? messages().cardPickManyPlaceholder
					: messages().cardPickOnePlaceholder,
			)
			.setMinValues(1)
			.setMaxValues(question.multi ? options.length : 1)
			.addOptions(options)
			.setDisabled(disabled),
	);
	if (!question.allowOther || roomForOther) return [menu];
	return [
		menu,
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${CARD_PREFIX}${id}:write`)
				.setLabel(messages().cardAnswerLabel)
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(disabled),
		),
	];
}

/** The Previews button of a single-question card: it shows the options' previews and answers nothing. */
export function previewsRow(id: string, disabled: boolean) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${CARD_PREFIX}${id}:previews`)
			.setLabel(messages().cardPreviewsLabel)
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(disabled),
	);
}

export function answerModal(id: string): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(`${CARD_PREFIX}${id}:text`)
		.setTitle(messages().cardModalTitle)
		.addLabelComponents(
			new LabelBuilder()
				.setLabel(messages().cardModalField)
				.setTextInputComponent(
					new TextInputBuilder()
						.setCustomId(TEXT_FIELD)
						.setStyle(TextInputStyle.Paragraph)
						.setRequired(true)
						.setMaxLength(1000),
				),
		);
}

export function answeredLine(answer: OwnerAnswer): string {
	const parts = [
		...answer.choices.map(plain),
		...(answer.text !== undefined
			? [messages().cardQuote(plain(answer.text))]
			: []),
	];
	return messages().cardAnswered(parts);
}

/**
 * An approval's controls: run, cancel, or the labels its wording gives, and, when the card offers
 * a copy, a copy button that stays usable once it ended.
 */
export function approvalRows(
	id: string,
	disabled: boolean,
	copy: { label: string } | undefined,
	labels?: { approve: string; decline: string },
): Rows {
	return [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${CARD_PREFIX}${id}:yes`)
				.setLabel(labels?.approve ?? messages().cardRunLabel)
				.setEmoji("✅")
				.setStyle(ButtonStyle.Success)
				.setDisabled(disabled),
			new ButtonBuilder()
				.setCustomId(`${CARD_PREFIX}${id}:no`)
				.setLabel(labels?.decline ?? messages().cardCancelLabel)
				.setEmoji("❌")
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(disabled),
			// Copying answers nothing, so it stays usable once the card has ended.
			...(copy
				? [
						new ButtonBuilder()
							.setCustomId(`${CARD_PREFIX}${id}:copy`)
							.setLabel(copy.label)
							.setEmoji("📋")
							.setStyle(ButtonStyle.Secondary),
					]
				: []),
		),
	];
}

/** The footer of a card its plugin withdrew: the reason it gave as plain text, or that the call was withdrawn. */
export function withdrawnFooter(signal: AbortSignal): string {
	return plain(withdrawalNote(signal, messages().cardWithdrawn));
}
