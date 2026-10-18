import { type Interaction, MessageFlags } from "discord.js";
import { messages } from "../i18n/index.ts";
import {
	checkQuestionnaireAnswer,
	type QuestionnaireAnswer,
} from "../interactions/questionnaire.ts";
import {
	answerOf,
	formFields,
	previewReplies,
	questionnaireModal,
} from "./owner-card-questionnaire.ts";
import {
	answeredLine,
	answerModal,
	OTHER,
	TEXT_FIELD,
} from "./owner-card-rows.ts";
import type { Answerer, OpenCard } from "./owner-card-types.ts";

const ephemeral = (content: string) => ({
	content,
	flags: MessageFlags.Ephemeral as const,
});

/** The single-question card's controls: a menu pick, "Write answer…", and the answer form. */
export async function answerSingle(
	card: OpenCard,
	id: string,
	action: string,
	interaction: Interaction,
	by: Answerer,
): Promise<void> {
	const question = card.question;
	if (!question) return;
	if (interaction.isButton() && action === "write") {
		card.picked = [];
		await interaction.showModal(answerModal(id));
		return;
	}
	if (interaction.isStringSelectMenu() && action === "pick") {
		const values = interaction.values;
		const choices = question.options.flatMap((option, i) =>
			values.includes(String(i)) ? [option.label] : [],
		);
		if (values.includes(OTHER)) {
			card.picked = choices;
			await interaction.showModal(answerModal(id));
			return;
		}
		const answer = { choices };
		card.end(answer, by);
		await interaction.update(card.view(answeredLine(answer)));
		return;
	}
	if (interaction.isModalSubmit() && action === "text") {
		const answer = {
			choices: card.picked ?? [],
			text: interaction.fields.getTextInputValue(TEXT_FIELD),
		};
		card.end(answer, by);
		if (interaction.isFromMessage())
			await interaction.update(card.view(answeredLine(answer)));
		else await interaction.deferUpdate();
	}
}

/** Previews answer nothing, so anyone who sees the card may open them. */
export async function showPreviews(
	card: OpenCard,
	interaction: Interaction,
): Promise<void> {
	const source = card.form?.questionnaire ?? card.previews;
	if (!interaction.isButton() || !source) return;
	const [first, ...rest] = previewReplies(source);
	if (first) await interaction.reply(first);
	for (const page of rest) await interaction.followUp(page);
}

/** Ends the card with `answer`; false when another press or the plugin ended it first. */
function finish(
	card: OpenCard,
	answer: QuestionnaireAnswer,
	by: Answerer,
): boolean {
	const draft = card.form?.draft;
	if (draft) {
		for (const [i, a] of answer.answers.entries()) {
			draft.choices[i] = [...(a?.choices ?? [])];
			draft.texts[i] = a?.text;
		}
		if (answer.note !== undefined) draft.note = answer.note;
	}
	return card.end(answer, by);
}

/** The note an ended card shows as its footer: the draft's note, when it has one. */
const endedFooter = (card: OpenCard) => {
	const note = card.form?.draft.note?.trim();
	return note ? messages().cardNoteLine(note) : "";
};

/**
 * A menu pick, Submit or the submitted form of a questionnaire card. The press is deferred first
 * (the audience lookup may take a while), then the audience and the card are checked: a refusal
 * or a closed card changes nothing, and a refused pick re-draws the card so their menu resets.
 */
export async function answerDeferred(
	card: OpenCard,
	action: string,
	index: number,
	interaction: Interaction,
	by: Answerer,
): Promise<void> {
	const form = card.form;
	if (!form) return;
	const picks = interaction.isStringSelectMenu() && action === "qpick";
	const submits = interaction.isButton() && action === "submit";
	const writes = interaction.isModalSubmit() && action === "qtext";
	if (!picks && !submits && !writes) return;
	await interaction.deferUpdate();
	const fromMessage =
		!interaction.isModalSubmit() || interaction.isFromMessage();
	if (!(await card.audience.allows(by.user))) {
		await interaction.followUp(ephemeral(card.audience.refusal));
		if (picks && card.isOpen())
			await interaction.editReply(card.view("", false));
		return;
	}
	// Stopped, withdrawn or answered meanwhile: the closed card must not be drawn open again.
	if (!card.isOpen()) {
		await interaction.followUp(ephemeral(messages().cardInactive));
		return;
	}
	const { questions } = form.questionnaire;
	if (picks) {
		const question = questions[index];
		if (!question) return;
		form.draft.choices[index] = question.options.flatMap((option, n) =>
			interaction.values.includes(String(n)) ? [option.label] : [],
		);
	} else if (writes) {
		const { texts, note } = formFields(form, (field) =>
			interaction.fields.getTextInputValue(field),
		);
		for (const [i, value] of texts)
			form.draft.texts[i] = value.trim() || undefined;
		form.draft.note = note.trim() || undefined;
	}
	if (!submits) {
		card.touch();
		if (fromMessage) await interaction.editReply(card.view("", false));
		return;
	}
	const answer = answerOf(form.draft);
	if (!checkQuestionnaireAnswer(form.questionnaire, answer)) {
		await interaction.followUp(ephemeral(messages().cardNothingYet));
		return;
	}
	if (!finish(card, answer, by)) {
		await interaction.followUp(ephemeral(messages().cardInactive));
		return;
	}
	await interaction.editReply(card.view(endedFooter(card)));
}

/** "Write answers / note…": opens the form, which a modal cannot defer; the audience was checked. */
export async function answerForm(
	card: OpenCard,
	id: string,
	action: string,
	interaction: Interaction,
): Promise<void> {
	if (!card.form || !interaction.isButton() || action !== "notes") return;
	if (!card.isOpen()) {
		await interaction.reply(ephemeral(messages().cardInactive));
		return;
	}
	await interaction.showModal(questionnaireModal(id, card.form));
}
