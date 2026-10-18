import type { ChatSurface } from "../contract/surface.ts";
import type {
	Questionnaire,
	QuestionnaireAnswer,
} from "../interactions/questionnaire.ts";
import { silentLogger } from "../log.ts";
import { partial } from "../testing/partial.ts";
import type { SurfaceObservation } from "../testing/surface-contract.ts";
import { describeQuestionnaireContract } from "../testing/surface-contract-questionnaire.ts";
import { CARD_PREFIX, OwnerCards } from "./owner-cards.ts";
import { fakeChannel, OWNER, press } from "./owner-cards-fixture.ts";

/** The Discord card layer as the questionnaire contract sees it: the cards a channel was sent. */
async function discordSubject() {
	const fake = fakeChannel();
	/** Cards a press closed by editing its own reply. */
	const closed: string[] = [];
	const cards = new OwnerCards({
		ownerId: OWNER,
		channel: fake.channel,
		logger: silentLogger(),
	});
	const surface = partial<ChatSurface>({
		surface: "discord",
		start: async () => undefined,
		stop: async () => undefined,
		sendReply: async () => undefined,
		prompts: (channel, scope) => cards.prompts(channel, scope),
	});
	const idOf = (index: number) => {
		const text = JSON.stringify(
			fake.sent[index]?.components.map((c) => c.toJSON()),
		);
		return text.match(new RegExp(`${CARD_PREFIX}([0-9a-f-]+):`))?.[1] ?? "";
	};
	/** The person fills the card in as Discord sends it: menus, the form, then Submit. */
	const answerAs =
		(user: string) =>
		async (
			id: string,
			answer: QuestionnaireAnswer,
			set: Questionnaire,
		): Promise<void> => {
			const custom = (action: string) => `${CARD_PREFIX}${id}:${action}`;
			for (const [i, given] of answer.answers.entries()) {
				const values = (given?.choices ?? []).map((label) =>
					String(set.questions[i]?.options.findIndex((o) => o.label === label)),
				);
				if (values.length > 0)
					await cards.handle(
						press("select", custom(`qpick:${i}`), { user, values }).interaction,
					);
			}
			const fields: Record<string, string> = {};
			for (const [i, given] of answer.answers.entries())
				if (given?.text !== undefined) fields[`t${i}`] = given.text;
			if (answer.note !== undefined) fields.note = answer.note;
			if (Object.keys(fields).length > 0)
				await cards.handle(
					press("modal", custom("qtext"), { user, fields }).interaction,
				);
			const submit = press("button", custom("submit"), { user });
			await cards.handle(submit.interaction);
			if (submit.edited.length > 0) closed.push(id);
		};
	return {
		surface,
		channel: "discord:555" as const,
		speaker: {
			id: OWNER,
			name: "Ada",
			tier: "owner" as const,
			principalId: OWNER,
		},
		write: async () => undefined,
		observations: (): SurfaceObservation[] => [
			...fake.sent.map((_, i) => ({
				kind: "prompt" as const,
				id: idOf(i),
				title: "Questions",
			})),
			...[...new Set([...closed, ...fake.edited.map(idOf)])].map((id) => ({
				kind: "prompt_closed" as const,
				id,
			})),
		],
		answerQuestionnaire: answerAs(OWNER),
		stranger: {
			answer: async () => undefined,
			answerQuestionnaire: answerAs("1"),
		},
	};
}

describeQuestionnaireContract("the Discord card", discordSubject);
