import { messages } from "../i18n/index.ts";
import type {
	OwnerAnswer,
	PromptScope,
	Prompts,
} from "../interactions/prompts.ts";
import type {
	AskSupport,
	QuestionnaireAnswer,
} from "../interactions/questionnaire.ts";
import type { CardAudiences } from "./card-audience.ts";
import type { QuestionnaireForm } from "./owner-card-questionnaire.ts";
import { newDraft, questionnaireCard } from "./owner-card-questionnaire.ts";
import { askRows } from "./owner-card-rows.ts";
import type { PostCard } from "./owner-card-types.ts";

/** What the Discord card shows of a questionnaire: four questions, previews, and a note. */
export const DISCORD_ASKS: AskSupport = {
	questions: 4,
	previews: true,
	note: true,
};

/** A channel's question cards: one question on its own card, or up to four on one. */
export function askPrompts(args: {
	channelId: string;
	scope: PromptScope | undefined;
	audiences: CardAudiences;
	post: PostCard;
}): Pick<Prompts, "ask" | "asks" | "questionnaire"> {
	const { channelId, scope, audiences, post } = args;
	return {
		asks: DISCORD_ASKS,
		ask: async (title, question, signal, wait) => {
			const audience = await audiences.question(scope);
			if (!audience) return undefined;
			return post<OwnerAnswer | "pending" | undefined>(
				channelId,
				signal,
				undefined,
				undefined,
				{
					audience,
					...(wait
						? {
								wait: {
									pending: "pending",
									late: (value, by) =>
										wait.late({
											kind: "question",
											answer: value as OwnerAnswer,
											by: by.user.name,
										}),
								},
							}
						: {}),
					title,
					sections: [question.question],
					question,
					rows: (id, disabled) => askRows(id, question, disabled),
					footer: messages().cardQuestionFooter,
				},
			);
		},
		questionnaire: async (title, questionnaire, signal, wait) => {
			const audience = await audiences.question(scope);
			if (!audience) return undefined;
			const n = questionnaire.questions.length;
			const form: QuestionnaireForm = {
				questionnaire,
				draft: newDraft(n),
				immediate: n === 1,
			};
			return post<QuestionnaireAnswer | "pending" | undefined>(
				channelId,
				signal,
				undefined,
				undefined,
				{
					audience,
					...(wait
						? {
								wait: {
									pending: "pending",
									late: (value, by) =>
										wait.late({
											kind: "questionnaire",
											answer: value as QuestionnaireAnswer,
											by: by.user.name,
										}),
								},
							}
						: {}),
					title,
					sections: [],
					form,
					build: (id, footer, disabled) =>
						questionnaireCard({
							id,
							title,
							note: audience.note,
							form,
							disabled,
							footer,
						}),
					footer: "",
				},
			);
		},
	};
}
