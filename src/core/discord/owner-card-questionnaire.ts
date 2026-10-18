import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { messages } from "../i18n/index.ts";
import {
	type OwnerQuestion,
	QUESTIONNAIRE_LIMITS,
	type Questionnaire,
	type QuestionnaireAnswer,
} from "../interactions/questionnaire.ts";
import { CARD_PREFIX } from "./owner-card-rows.ts";
import type { CardPayload } from "./owner-card-types.ts";
import { ephemeralPanel, ownerPanels, plain } from "./owner-panel.ts";
import { clip } from "./utf16.ts";

/** What has been chosen and written on a questionnaire card so far; one per card, shared by all who may answer. */
export interface Draft {
	choices: string[][];
	texts: (string | undefined)[];
	note?: string;
}

/** A card's questionnaire with its draft. */
export interface QuestionnaireForm {
	questionnaire: Questionnaire;
	draft: Draft;
}

export const newDraft = (questions: number): Draft => ({
	choices: Array.from({ length: questions }, () => []),
	texts: Array.from({ length: questions }, () => undefined),
});

const cut = (text: string, max: number) => clip(text, max, true);

const text = (content: string) => new TextDisplayBuilder().setContent(content);

/** Whether the question takes text of its own: it has no options, or allows an answer besides them. */
export const takesText = (question: OwnerQuestion) =>
	question.allowOther || question.options.length === 0;

const given = (draft: Draft, i: number) =>
	(draft.choices[i]?.length ?? 0) > 0 || draft.texts[i] !== undefined;

export const answeredCount = (draft: Draft) =>
	draft.choices.filter((_, i) => given(draft, i)).length;

/** The draft as an answer: a blank question is undefined, a blank note is left out. */
export function answerOf(draft: Draft): QuestionnaireAnswer {
	const note = draft.note?.trim();
	return {
		answers: draft.choices.map((choices, i) => {
			const own = draft.texts[i]?.trim();
			return choices.length > 0 || own
				? { choices: [...choices], ...(own ? { text: own } : {}) }
				: undefined;
		}),
		...(note ? { note } : {}),
	};
}

/** One question's draft as a line: what is chosen and written, or that it is not answered. */
function lineOf(draft: Draft, i: number): string {
	if (!given(draft, i)) return messages().cardUnanswered;
	const own = draft.texts[i];
	return messages().cardAnswered([
		...(draft.choices[i] ?? []).map(plain),
		...(own !== undefined ? [messages().cardQuote(plain(own))] : []),
	]);
}

/** A question's name: its header, else its text cut short. */
const nameOf = (question: OwnerQuestion) =>
	plain(question.header ?? cut(question.question, 80));

function select(
	id: string,
	i: number,
	question: OwnerQuestion,
	draft: Draft,
	disabled: boolean,
) {
	const chosen = draft.choices[i] ?? [];
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`${CARD_PREFIX}${id}:qpick:${i}`)
			.setPlaceholder(
				question.multi
					? messages().cardPickManyPlaceholder
					: messages().cardPickOnePlaceholder,
			)
			.setMinValues(0)
			.setMaxValues(question.multi ? question.options.length : 1)
			.addOptions(
				question.options.map((option, n) => ({
					label: clip(option.label, 100),
					value: String(n),
					default: chosen.includes(option.label),
					...(option.description
						? { description: clip(option.description, 100) }
						: {}),
				})),
			)
			.setDisabled(disabled),
	);
}

function buttons(id: string, form: QuestionnaireForm, disabled: boolean) {
	const { questions } = form.questionnaire;
	const row = new ActionRowBuilder<ButtonBuilder>();
	const button = (action: string, label: string, style: ButtonStyle) =>
		new ButtonBuilder()
			.setCustomId(`${CARD_PREFIX}${id}:${action}`)
			.setLabel(label)
			.setStyle(style)
			.setDisabled(disabled);
	row.addComponents(
		button("submit", messages().cardSubmitLabel, ButtonStyle.Primary),
		button("notes", messages().cardWriteLabel, ButtonStyle.Secondary),
	);
	if (questions.some((q) => q.options.some((o) => o.preview !== undefined)))
		row.addComponents(
			button("previews", messages().cardPreviewsLabel, ButtonStyle.Secondary),
		);
	return row.components.length > 0 ? [row] : [];
}

/**
 * A questionnaire card as one message. Discord lets a container hold ten children, so the
 * heading, the four questions' texts and menus, and the button row fill it; the footer is a
 * top-level text beneath it. Open, each question shows its text and menu; ended, its name and
 * what was chosen, with the controls disabled.
 */
export function questionnaireCard(args: {
	id: string;
	title: string;
	/** The audience's note, shown with the heading; empty for none. */
	note: string;
	form: QuestionnaireForm;
	disabled: boolean;
	/** How the card ended, shown as its footer; ignored while it is open. */
	footer: string;
}): CardPayload {
	const { id, form, disabled } = args;
	const { draft } = form;
	const { questions } = form.questionnaire;
	const container = new ContainerBuilder().addTextDisplayComponents(
		text([`### ${args.title}`, ...(args.note ? [args.note] : [])].join("\n")),
	);
	for (const [i, question] of questions.entries()) {
		const heading =
			questions.length === 1
				? undefined
				: `**${i + 1}${question.header ? ` · ${plain(question.header)}` : ""}**`;
		const body = disabled
			? `${heading ?? `**${nameOf(question)}**`}\n${lineOf(draft, i)}`
			: [heading, question.question].filter(Boolean).join("\n");
		container.addTextDisplayComponents(text(body));
		if (question.options.length > 0)
			container.addActionRowComponents(
				select(id, i, question, draft, disabled),
			);
	}
	container.addActionRowComponents(...buttons(id, form, disabled));
	const footer = disabled
		? args.footer
		: messages().cardQuestionnaireFooter(
				answeredCount(draft),
				questions.length,
			);
	return {
		components: [container, ...(footer ? [text(`-# ${footer}`)] : [])],
		flags: MessageFlags.IsComponentsV2,
		allowedMentions: { parse: [] },
	};
}

/** The form for what the menus cannot take: each question's own answer, and the note. */
export function questionnaireModal(id: string, form: QuestionnaireForm) {
	const { questions } = form.questionnaire;
	const labelled = (
		label: string,
		field: string,
		value: string | undefined,
		description?: string,
	) => {
		const input = new TextInputBuilder()
			.setCustomId(field)
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(QUESTIONNAIRE_LIMITS.answerChars);
		// Discord refuses an empty prefill and an empty description.
		if (value) input.setValue(value);
		const labelled = new LabelBuilder()
			.setLabel(cut(label, 45))
			.setTextInputComponent(input);
		return description
			? labelled.setDescription(cut(description, 100))
			: labelled;
	};
	const modal = new ModalBuilder()
		.setCustomId(`${CARD_PREFIX}${id}:qtext`)
		.setTitle(messages().cardModalTitle);
	for (const [i, question] of questions.entries()) {
		if (!takesText(question)) continue;
		const label =
			questions.length === 1
				? messages().cardModalField
				: `${i + 1}. ${question.header ?? messages().cardQuestionName(i + 1)}`;
		const field = labelled(
			label,
			`t${i}`,
			form.draft.texts[i],
			question.question,
		);
		modal.addLabelComponents(field);
	}
	return modal.addLabelComponents(
		labelled(messages().cardNoteField, "note", form.draft.note),
	);
}

/** The text fields a submitted form carries, by question index; `note` is the note. */
export function formFields(
	form: QuestionnaireForm,
	read: (field: string) => string,
): { texts: Map<number, string>; note: string } {
	const texts = new Map<number, string>();
	for (const [i, question] of form.questionnaire.questions.entries())
		if (takesText(question)) texts.set(i, read(`t${i}`));
	return { texts, note: read("note") };
}

/** Every option's preview, question by question, as an ephemeral reply and follow-ups; a file when a preview holds a code fence. */
export function previewReplies(questionnaire: Questionnaire) {
	const sections = questionnaire.questions.flatMap((question, i) => {
		const shown = question.options.filter((o) => o.preview !== undefined);
		if (shown.length === 0) return [];
		return [
			`**${i + 1}. ${nameOf(question)}**`,
			...shown.map(
				(o) => `**${plain(o.label)}**\n\`\`\`\n${o.preview}\n\`\`\``,
			),
		];
	});
	const raw = questionnaire.questions
		.flatMap((question, i) =>
			question.options
				.filter((o) => o.preview !== undefined)
				.map((o) => `## ${i + 1}. ${o.label}\n\n${o.preview}`),
		)
		.join("\n\n");
	if (raw.includes("```"))
		return [
			{
				content: messages().cardPreviewsFile,
				files: [
					new AttachmentBuilder(Buffer.from(raw, "utf8"), {
						name: "previews.md",
					}),
				],
				flags: MessageFlags.Ephemeral as const,
				allowedMentions: { parse: [] as never[] },
			},
		];
	return ownerPanels({
		title: messages().cardPreviewsLabel,
		sections,
	}).map(ephemeralPanel);
}
