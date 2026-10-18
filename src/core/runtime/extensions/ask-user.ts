import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import type { OwnerQuestion } from "../../interactions/prompts.ts";
import { QUESTIONNAIRE_LIMITS as L } from "../../interactions/questionnaire.ts";
import { toolText } from "../../shared/tool-result.ts";
import { askQuestions } from "../ask-questions.ts";
import type { PromptSlot } from "../prompt-slot.ts";
import { foldAskArguments } from "./ask-user-arguments.ts";

export { answerText, lateAnswerText } from "./ask-user-text.ts";

export const ASK_USER_TOOL = "ask_user";

/** Registers ask_user, which asks the owner on a card in the turn's channel and waits. */
export function askUserExtension(
	slot: PromptSlot,
	owner: OwnerIdentity,
	/** Whom the running turn is for, when not the owner; the answer's words name them. */
	addressee?: () => OwnerIdentity,
): ExtensionFactory {
	const o = ownerWords(owner);
	return (pi) => {
		const parameters = Type.Object(
			{
				questions: Type.Array(
					Type.Object(
						{
							question: Type.String({
								minLength: 1,
								maxLength: L.questionChars,
							}),
							header: Type.Optional(
								Type.String({
									maxLength: L.headerChars,
									description: "A short name for the question in a set.",
								}),
							),
							options: Type.Optional(
								Type.Array(
									Type.Object(
										{
											label: Type.String({
												minLength: 1,
												maxLength: L.labelChars,
											}),
											description: Type.Optional(
												Type.String({ maxLength: L.descriptionChars }),
											),
											preview: Type.Optional(
												Type.String({
													maxLength: L.previewChars,
													description:
														"A markdown mock-up or snippet shown with the option.",
												}),
											),
										},
										{ additionalProperties: false },
									),
									{ maxItems: L.options },
								),
							),
							multi: Type.Optional(
								Type.Boolean({ description: "Several options may be chosen." }),
							),
							allow_other: Type.Optional(
								Type.Boolean({
									description: `${o.He} may write an answer besides the options (default true; false for a closed choice).`,
								}),
							),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1, maxItems: L.questions },
				),
			},
			{ additionalProperties: false },
		);
		pi.registerTool({
			name: ASK_USER_TOOL,
			label: `Ask ${o.name}`,
			description: `Ask ${o.name} a question, or up to four related ones, on a card with buttons in this channel and wait for ${o.his} answer, within this turn. Use it when you need ${o.his} decision to continue, instead of ending your turn with a question. The card should read on its own, so put the context ${o.he} needs in the question too. Put every question you have into one call as questions. Offer options when the choices are known, each with a short description, and a preview (markdown) when seeing the option helps; set multi when several may apply, and allow_other to false for a closed choice (otherwise ${o.he} may write ${o.his} own answer). Give each question a short header when you ask several. If ${o.he} does not answer soon, the result says so and the card stays open: then end your turn saying you are waiting, and ${o.his} answer comes in a new turn.`,
			parameters,
			prepareArguments: (args) =>
				foldAskArguments(args) as Static<typeof parameters>,
			execute: async (_toolCallId, params, signal) => {
				const prompts = slot.prompts;
				if (!prompts)
					return toolText(
						`${o.name} cannot answer buttons in this turn, such as a schedule's. Ask ${o.him} in your reply instead.`,
					);
				const p = params as {
					questions: {
						question: string;
						header?: string;
						options?: OwnerQuestion["options"];
						multi?: boolean;
						allow_other?: boolean;
					}[];
				};
				return toolText(
					await askQuestions(
						prompts,
						slot.asker,
						{
							questions: p.questions.map((q) => ({
								question: q.question,
								...(q.header !== undefined ? { header: q.header } : {}),
								options: q.options ?? [],
								multi: q.multi === true,
								allowOther: q.allow_other !== false,
							})),
						},
						addressee?.() ?? owner,
						signal,
					),
				);
			},
		});
	};
}
