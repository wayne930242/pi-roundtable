import { describe, expect, test } from "bun:test";
import type {
	OwnerAnswer,
	Prompts,
	PromptWait,
	Questionnaire,
	QuestionnaireAnswer,
} from "../interactions/prompts.ts";
import { TEST_OWNER as OWNER } from "../testing/owner.ts";
import { askQuestions } from "./ask-questions.ts";
import { PromptSlot } from "./prompt-slot.ts";

const two: Questionnaire = {
	questions: [
		{
			question: "Feature type?",
			header: "Type",
			options: [{ label: "Bug" }],
			multi: false,
			allowOther: true,
		},
		{
			question: "Testing?",
			options: [{ label: "Unit" }, { label: "E2E" }],
			multi: true,
			allowOther: true,
		},
		{
			question: "Release?",
			header: "Release",
			options: [],
			multi: false,
			allowOther: true,
		},
	],
};

function v1(answers: (OwnerAnswer | "pending" | undefined)[]) {
	const asked: string[] = [];
	const waits: PromptWait[] = [];
	const prompts: Prompts = {
		confirm: async () => "expired",
		ask: async (_t, question, _s, wait) => {
			asked.push(question.question);
			if (wait) waits.push(wait);
			return answers[asked.length - 1];
		},
	};
	return { prompts, asked, waits };
}

function v2(
	answer: QuestionnaireAnswer | "pending" | undefined,
	questions = 4,
) {
	const sent: Questionnaire[] = [];
	const waits: PromptWait[] = [];
	const prompts: Prompts = {
		confirm: async () => "expired",
		ask: async () => {
			throw new Error("ask must not be used");
		},
		asks: { questions, previews: true, note: true },
		questionnaire: async (_t, q, _s, wait) => {
			sent.push(q);
			if (wait) waits.push(wait);
			return answer;
		},
	};
	return { prompts, sent, waits };
}

const run = (prompts: Prompts, q: Questionnaire) =>
	askQuestions(prompts, "infra", q, OWNER, undefined);

describe("askQuestions", () => {
	test("a questionnaire surface gets one card and the answer is listed per question", async () => {
		const { prompts, sent } = v2({
			answers: [
				{ choices: ["Bug"] },
				{ choices: ["Unit", "E2E"], text: "and a smoke test" },
				undefined,
			],
			note: "ship it Friday",
		});
		expect(await run(prompts, two)).toBe(
			[
				"Riley answered your questions on the card:",
				"1. Type: chose Bug",
				"2. Testing?: chose Unit; E2E. Wrote: and a smoke test",
				"3. Release: not answered",
				"Note: ship it Friday",
			].join("\n"),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.questions).toHaveLength(3);
	});

	test("pending, no answer and the late turn", async () => {
		const pending = v2("pending");
		expect(await run(pending.prompts, two)).toContain("has not answered yet");
		const late = pending.waits[0]?.late({
			kind: "questionnaire",
			answer: { answers: [{ choices: ["Bug"] }, undefined, undefined] },
			by: "Ada",
		});
		expect(late).toStartWith(
			"(Ada answered your earlier ask_user questions on their card, after your turn had ended.",
		);
		expect(late).toContain("1. Type: chose Bug");
		expect(late).toContain("3. Release: not answered");
		expect(
			pending.waits[0]?.late({
				kind: "question",
				answer: { choices: [] },
				by: "x",
			}),
		).toBeUndefined();
		expect(await run(v2(undefined).prompts, two)).toStartWith("No answer");
	});

	test("a single question with previews uses the card only where previews show", async () => {
		const one: Questionnaire = {
			questions: [
				{
					question: "Pick?",
					options: [{ label: "a", preview: "x" }],
					multi: false,
					allowOther: false,
				},
			],
		};
		const withPreviews = v2({ answers: [{ choices: ["a"] }] });
		expect(await run(withPreviews.prompts, one)).toContain(
			"answered your questions",
		);
		const noPreviews = v1([{ choices: ["a"] }]);
		const prompts: Prompts = {
			...noPreviews.prompts,
			asks: { questions: 4, previews: false, note: true },
			questionnaire: async () => {
				throw new Error("not this");
			},
		};
		expect(await run(prompts, one)).toBe("Riley chose: a");
		expect(noPreviews.asked[0]).toContain("**a**");
	});

	test("a questionnaire surface with room for fewer questions falls back to asking one at a time", async () => {
		const small = v2(undefined, 2);
		const { prompts } = v1([{ choices: ["Bug"] }]);
		prompts.asks = small.prompts.asks;
		prompts.questionnaire = small.prompts.questionnaire;
		await run(prompts, two);
		expect(small.sent).toHaveLength(0);
	});

	describe("one at a time", () => {
		test("all answered", async () => {
			const { prompts, asked } = v1([
				{ choices: ["Bug"] },
				{ choices: ["Unit"] },
				{ choices: [], text: "Friday" },
			]);
			expect(await run(prompts, two)).toBe(
				[
					"Riley answered your questions on the card:",
					"1. Type: chose Bug",
					"2. Testing?: chose Unit",
					"3. Release: Wrote: Friday",
				].join("\n"),
			);
			expect(asked).toHaveLength(3);
		});

		test("pending in the middle stops and reports the rest", async () => {
			const { prompts, asked, waits } = v1([{ choices: ["Bug"] }, "pending"]);
			const text = await run(prompts, two);
			expect(asked).toHaveLength(2);
			expect(text).toContain("1. Type: chose Bug");
			expect(text).toContain("has not answered yet");
			expect(text).toContain(
				"Not asked: 3. Release; this channel takes one question at a time, so ask again if you still need them.",
			);
			expect(
				waits[1]?.late({
					kind: "question",
					answer: { choices: ["Unit"] },
					by: "Ada",
				}),
			).toContain("Question: Testing?");
		});

		test("no answer in the middle stops", async () => {
			const { prompts, asked } = v1([undefined]);
			const text = await run(prompts, two);
			expect(asked).toHaveLength(1);
			expect(text).toStartWith("No answer");
			expect(text).toContain("Not asked: 2. Testing?; 3. Release;");
		});
	});
});

describe("PromptSlot", () => {
	test("a v1 Prompts bound has no questionnaire, and the fallback runs", async () => {
		const slot = new PromptSlot();
		const { prompts, asked } = v1([{ choices: ["Bug"] }, undefined]);
		slot.bind(prompts, "infra");
		const bound = slot.prompts;
		expect(bound?.asks).toBeUndefined();
		expect(bound?.questionnaire).toBeUndefined();
		if (!bound) throw new Error("unbound");
		await run(bound, two);
		expect(asked).toHaveLength(2);
	});

	test("a questionnaire Prompts keeps asks and questionnaire through the slot", async () => {
		const slot = new PromptSlot();
		const { prompts, sent } = v2({
			answers: [{ choices: ["Bug"] }, undefined, undefined],
		});
		slot.bind(prompts, "infra");
		expect(slot.prompts?.asks).toEqual(prompts.asks);
		const bound = slot.prompts;
		if (!bound) throw new Error("unbound");
		expect(await run(bound, two)).toContain("1. Type: chose Bug");
		expect(sent).toHaveLength(1);
	});
});
