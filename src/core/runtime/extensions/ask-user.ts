import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import type { OwnerQuestion } from "../../interactions/prompts.ts";
import { QUESTIONNAIRE_LIMITS as L } from "../../interactions/questionnaire.ts";
import { DEFAULT_YOLO_QUESTION_GRACE_MS } from "../../modes/autonomy.ts";
import { toolText } from "../../shared/tool-result.ts";
import { askQuestions } from "../ask-questions.ts";
import type { PromptSlot } from "../prompt-slot.ts";
import { foldAskArguments } from "./ask-user-arguments.ts";
import { yoloAskNote } from "./ask-user-text.ts";

export { answerText, lateAnswerText } from "./ask-user-text.ts";

export const ASK_USER_TOOL = "ask_user";

/**
 * Registers ask_user, which asks the owner on a card in the turn's channel and waits. In a turn
 * whose conversation is in yolo mode (`slot.yolo`), a card holds the turn `yoloGraceMs` at most and
 * an unanswered one does not end it, and the system prompt carries the yolo note.
 */
export function askUserExtension(
	slot: PromptSlot,
	owner: OwnerIdentity,
	/** Whom the running turn is for, when not the owner; the answer's words name them. */
	addressee?: () => OwnerIdentity,
	/** Whether the host is shutting down: no card is posted then, as none survives the restart. */
	stopping?: () => boolean,
	/** How long a card holds a yolo turn, in ms; default `DEFAULT_YOLO_QUESTION_GRACE_MS`. */
	yoloGraceMs: number = DEFAULT_YOLO_QUESTION_GRACE_MS,
): ExtensionFactory {
	const o = ownerWords(owner);
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			if (!slot.yolo) return;
			const note = yoloAskNote(addressee?.() ?? owner);
			const appended = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = appended
				? `${appended}\n\n${note}`
				: note;
		});
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
						`${o.name} cannot answer buttons in this turn: no one wrote to you, a schedule or another agent started it, so nothing waits. Do not call ask_user again. Write the question as your final answer instead; it is posted to this channel for ${o.him} to read, and ${o.his} answer comes in a new turn.`,
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
						stopping,
						slot.yolo ? yoloGraceMs : undefined,
					),
				);
			},
		});
	};
}
