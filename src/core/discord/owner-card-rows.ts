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
import type { OwnerAnswer, OwnerQuestion } from "../interactions/prompts.ts";
import { type ownerPanel, plain } from "./owner-panel.ts";

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
	// Discord menus take 25 options; "Other…" takes the last place when the options fill it.
	const options = question.options
		.slice(0, question.allowOther ? 24 : 25)
		.map((option, i) => ({
			label: option.label.slice(0, 100),
			value: String(i),
			...(option.description
				? { description: option.description.slice(0, 100) }
				: {}),
		}));
	if (question.allowOther)
		options.push({
			label: messages().cardOtherLabel,
			value: OTHER,
			description: messages().cardOtherDescription,
		});
	return [
		new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
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
		),
	];
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
