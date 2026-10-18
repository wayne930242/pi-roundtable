import { describe, test } from "bun:test";
import {
	type AskSupport,
	type Questionnaire,
	type QuestionnaireAnswer,
	shapeFor,
} from "../interactions/questionnaire.ts";
import type { SurfaceContractSubject } from "./surface-contract.ts";
import {
	ContractBroken,
	expectThat,
	nextPrompt,
	type Running,
	runCheck,
	scopeOf,
	seen,
	until,
} from "./surface-contract-support.ts";

/** One check of the questionnaire part of the surface contract. */
export interface QuestionnaireCheck {
	name: string;
	applies(subject: SurfaceContractSubject): boolean;
	run(running: Running): Promise<void>;
}

/** The set the checks ask: two questions, the first with previews where the surface shows them. */
function contractSet(asks: AskSupport): Questionnaire {
	const preview = asks.previews ? { preview: "```\nlayout\n```" } : {};
	const day = {
		question: "Which day?",
		header: "Day",
		options: [
			{ label: "Saturday", ...preview },
			{ label: "Sunday", ...preview },
		],
		multi: false,
		allowOther: true,
	};
	const food = {
		question: "Which food?",
		options: [{ label: "Rice" }, { label: "Noodles" }],
		multi: true,
		allowOther: false,
	};
	return shapeFor(
		{ questions: asks.questions >= 2 ? [day, food] : [day] },
		asks,
	);
}

/** The person's prompts, once the surface has started; undefined where it declares no `asks`. */
function questionnairePrompts(running: Running) {
	const { surface, channel } = running.subject;
	const prompts = surface.prompts?.(channel, scopeOf(running.subject));
	if (!prompts?.asks || !prompts.questionnaire)
		throw new ContractBroken(
			"the subject answers questionnaires, but its prompts declare no asks",
		);
	return { prompts, asks: prompts.asks, ask: prompts.questionnaire };
}

const answerOf = (
	set: Questionnaire,
	asks: AskSupport,
): QuestionnaireAnswer => ({
	answers: set.questions.map((_, i) =>
		i === 0 ? { choices: ["Sunday"] } : undefined,
	),
	...(asks.note ? { note: "thanks" } : {}),
});

const applies = (subject: SurfaceContractSubject) =>
	subject.surface.prompts !== undefined &&
	subject.answerQuestionnaire !== undefined;

/**
 * The questionnaire checks. They apply to a subject that gives `answerQuestionnaire`, which must declare `asks`;
 * a surface that takes one question at a time gives none and is skipped.
 */
export const QUESTIONNAIRE_CHECKS: readonly QuestionnaireCheck[] = [
	{
		name: "a questionnaire resolves as the person answers it, keeps a blank question blank, and closes",
		applies,
		run: async (running) => {
			const found = questionnairePrompts(running);
			const answer = running.subject.answerQuestionnaire;
			if (!answer) return;
			const set = contractSet(found.asks);
			const before = seen(running, "prompt").length;
			const result = found.ask("Questions", set);
			const id = await nextPrompt(running, before);
			const given = answerOf(set, found.asks);
			await answer(id, given, set);
			const got = await result;
			if (got === "pending" || got === undefined)
				throw new ContractBroken(`the person's answers came back ${got}`);
			expectThat(
				JSON.stringify(got.answers.map((a) => a ?? null)) ===
					JSON.stringify(given.answers.map((a) => a ?? null)),
				`the answers came back as ${JSON.stringify(got.answers)}`,
			);
			expectThat(
				got.note === given.note,
				`the note came back as ${JSON.stringify(got.note)}`,
			);
			await until(
				() =>
					seen(running, "prompt_closed").some(
						(o) => o.kind === "prompt_closed" && o.id === id,
					),
				"the answered questionnaire closes",
			);
		},
	},
	{
		name: "a stopped turn's questionnaire resolves with no answer and closes",
		applies,
		run: async (running) => {
			const found = questionnairePrompts(running);
			const stop = new AbortController();
			const before = seen(running, "prompt").length;
			const result = found.ask(
				"Questions",
				contractSet(found.asks),
				stop.signal,
			);
			const id = await nextPrompt(running, before);
			stop.abort();
			const got = await result;
			expectThat(
				got === undefined,
				`a stopped turn's questionnaire got ${got}`,
			);
			await until(
				() =>
					seen(running, "prompt_closed").some(
						(o) => o.kind === "prompt_closed" && o.id === id,
					),
				"the stopped questionnaire closes",
			);
		},
	},
	{
		name: "another person cannot answer the person's questionnaire",
		applies: (subject) =>
			applies(subject) && subject.stranger?.answerQuestionnaire !== undefined,
		run: async (running) => {
			const found = questionnairePrompts(running);
			const stranger = running.subject.stranger;
			const answer = running.subject.answerQuestionnaire;
			if (!answer || !stranger?.answerQuestionnaire) return;
			await stranger.join?.();
			const set = contractSet(found.asks);
			const before = seen(running, "prompt").length;
			let settled: unknown;
			const result = found.ask("Questions", set).then((value) => {
				settled = value;
				return value;
			});
			const id = await nextPrompt(running, before);
			await stranger.answerQuestionnaire(id, answerOf(set, found.asks), set);
			await Bun.sleep(50);
			expectThat(
				settled === undefined,
				"another person's answer settled the questionnaire",
			);
			await answer(id, answerOf(set, found.asks), set);
			const own = await result;
			expectThat(
				own !== "pending" && own !== undefined,
				`the person's answer came back ${own}`,
			);
		},
	},
];

/**
 * Registers only the questionnaire part of the contract, for a card layer without a chat around
 * it. Internal: the published contract is `describeSurfaceContract`.
 */
export function describeQuestionnaireContract(
	name: string,
	make: () => Promise<SurfaceContractSubject>,
): void {
	describe(`${name} keeps the questionnaire contract`, () => {
		for (const check of QUESTIONNAIRE_CHECKS)
			test(check.name, async () => {
				await runCheck(check, make);
			});
	});
}
