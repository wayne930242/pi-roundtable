import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwnerAnswer, OwnerQuestion } from "../../domain/owner-prompts.ts";
import { messages } from "../../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import { toolText } from "../../shared/tool-result.ts";
import type { PromptSlot } from "../prompt-slot.ts";

export const ASK_USER_TOOL = "ask_user";

/** The tool's result: what the owner chose and wrote. */
export function answerText(
	answer: OwnerAnswer | undefined,
	owner: OwnerIdentity,
): string {
	const o = ownerWords(owner);
	if (!answer)
		return `No answer: ${o.name} did not answer in time. Go on without it if you safely can, otherwise ask in your reply.`;
	const lines = [
		...(answer.choices.length > 0
			? [`${o.name} chose: ${answer.choices.join("; ")}`]
			: []),
		...(answer.text !== undefined ? [`${o.name} wrote: ${answer.text}`] : []),
	];
	return lines.length > 0 ? lines.join("\n") : `${o.name} chose nothing.`;
}

/** Registers ask_user, which asks the owner on a card in the turn's channel and waits. */
export function askUserExtension(
	slot: PromptSlot,
	owner: OwnerIdentity,
	/** Whom the running turn is for, when not the owner; the answer's words name them. */
	addressee?: () => OwnerIdentity,
): ExtensionFactory {
	const o = ownerWords(owner);
	return (pi) => {
		pi.registerTool({
			name: ASK_USER_TOOL,
			label: `Ask ${o.name}`,
			description: `Ask ${o.name} a question on a card with buttons in this channel and wait for ${o.his} answer, within this turn. Use it when you need ${o.his} decision to continue, instead of ending your turn with a question. The card should read on its own, so put the context ${o.he} needs in the question too. Offer options when the choices are known; set multi when several may apply and allow_other to let ${o.him} write ${o.his} own answer. ${o.He} has 30 minutes; after that the result says there was no answer.`,
			parameters: Type.Object(
				{
					question: Type.String({ minLength: 1, maxLength: 1500 }),
					options: Type.Optional(
						Type.Array(
							Type.Object(
								{
									label: Type.String({ minLength: 1, maxLength: 100 }),
									description: Type.Optional(Type.String({ maxLength: 100 })),
								},
								{ additionalProperties: false },
							),
							{ maxItems: 25 },
						),
					),
					multi: Type.Optional(
						Type.Boolean({ description: "Several options may be chosen." }),
					),
					allow_other: Type.Optional(
						Type.Boolean({
							description: `${o.He} may write an answer besides the options.`,
						}),
					),
				},
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params, signal) => {
				const prompts = slot.prompts;
				if (!prompts)
					return toolText(
						`${o.name} cannot answer buttons in this turn, such as a schedule's. Ask ${o.him} in your reply instead.`,
					);
				const p = params as {
					question: string;
					options?: { label: string; description?: string }[];
					multi?: boolean;
					allow_other?: boolean;
				};
				const question: OwnerQuestion = {
					question: p.question,
					options: p.options ?? [],
					multi: p.multi === true,
					allowOther: p.allow_other === true,
				};
				return toolText(
					answerText(
						await prompts.ask(
							messages().askTitle(slot.asker),
							question,
							signal,
						),
						addressee?.() ?? owner,
					),
				);
			},
		});
	};
}
