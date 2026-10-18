import { describe, expect, test } from "bun:test";
import type { Prompts } from "./prompts.ts";
import {
	checkAnswer,
	checkQuestionnaireAnswer,
	QUESTIONNAIRE_LIMITS as L,
	type OwnerQuestion,
	type Questionnaire,
	SINGLE_QUESTION,
	shapeFor,
	validateQuestionnaire,
} from "./questionnaire.ts";

const q = (over: Partial<OwnerQuestion> = {}): OwnerQuestion => ({
	question: "Which day?",
	options: [{ label: "Sat" }, { label: "Sun" }],
	multi: false,
	allowOther: false,
	...over,
});
const set = (...questions: OwnerQuestion[]): Questionnaire => ({ questions });

describe("validateQuestionnaire", () => {
	test("accepts one to four sound questions", () => {
		expect(validateQuestionnaire(set(q()))).toBeUndefined();
		const four = [1, 2, 3, 4].map((n) => q({ question: `Q${n}?` }));
		expect(validateQuestionnaire(set(...four))).toBeUndefined();
	});

	const refused: [string, Questionnaire, RegExp][] = [
		["no questions", set(), /between 1 and 4/],
		[
			"five questions",
			set(...[1, 2, 3, 4, 5].map((n) => q({ question: `Q${n}?` }))),
			/between 1 and 4/,
		],
		["a blank question", set(q({ question: "  " })), /empty/],
		[
			"a long single question",
			set(q({ question: "x".repeat(L.questionChars + 1) })),
			/over 1500/,
		],
		[
			"a long header",
			set(q({ header: "h".repeat(L.headerChars + 1) })),
			/header/,
		],
		[
			"too many options",
			set(
				q({
					options: Array.from({ length: 26 }, (_, i) => ({ label: `o${i}` })),
				}),
			),
			/at most 25/,
		],
		["a blank label", set(q({ options: [{ label: " " }] })), /no label/],
		[
			"a long label",
			set(q({ options: [{ label: "l".repeat(101) }] })),
			/label is over/,
		],
		[
			"a long description",
			set(q({ options: [{ label: "a", description: "d".repeat(101) }] })),
			/description is over/,
		],
		[
			"a long preview",
			set(
				q({
					options: [{ label: "a", preview: "p".repeat(L.previewChars + 1) }],
				}),
			),
			/preview of "a"/,
		],
		[
			"previews over the total",
			set(
				...[1, 2, 3, 4].map((n) =>
					q({
						question: `Q${n}?`,
						options: ["a", "b", "c"].map((label) => ({
							label,
							preview: "p".repeat(L.previewChars),
						})),
					}),
				),
			),
			/previews together/,
		],
		[
			"duplicate labels",
			set(q({ options: [{ label: "a" }, { label: "a" }] })),
			/offered twice/,
		],
		["duplicate questions", set(q(), q()), /asked twice/],
		[
			"a set over the shared budget",
			set(
				q({ question: "a".repeat(1500) }),
				q({ question: "b".repeat(1500) }),
				q({ question: "c" }),
			),
			/together are over 3000/,
		],
	];
	for (const [name, input, message] of refused)
		test(`refuses ${name}`, () => {
			expect(validateQuestionnaire(input)).toMatch(message);
		});

	test("a call with several questions names the question at fault", () => {
		expect(
			validateQuestionnaire(
				set(q(), q({ question: "x", options: [{ label: "" }] })),
			),
		).toStartWith("Question 2:");
	});
});

describe("checkAnswer", () => {
	const closed = q();
	const multi = q({ multi: true, allowOther: true });
	const free = q({ options: [] });
	const table: [
		string,
		OwnerQuestion,
		{ choices: string[]; text?: string },
		boolean,
	][] = [
		["a listed choice", closed, { choices: ["Sat"] }, true],
		["an unlisted choice", closed, { choices: ["Mon"] }, false],
		[
			"two choices on a single question",
			closed,
			{ choices: ["Sat", "Sun"] },
			false,
		],
		[
			"two choices on a multi question",
			multi,
			{ choices: ["Sat", "Sun"] },
			true,
		],
		["a repeated choice", multi, { choices: ["Sat", "Sat"] }, false],
		["own text where not allowed", closed, { choices: [], text: "Mon" }, false],
		["own text where allowed", multi, { choices: [], text: "Mon" }, true],
		["nothing", multi, { choices: [] }, false],
		["blank text only", multi, { choices: [], text: "  " }, false],
		["free text", free, { choices: [], text: "Nova" }, true],
		["free text with a choice", free, { choices: ["x"], text: "Nova" }, false],
		["free text left blank", free, { choices: [] }, false],
	];
	for (const [name, question, answer, ok] of table)
		test(name, () => expect(checkAnswer(question, answer)).toBe(ok));
});

describe("checkQuestionnaireAnswer", () => {
	const two = set(q(), q({ question: "Free?", options: [] }));
	test("accepts partial answers and a note alone", () => {
		expect(
			checkQuestionnaireAnswer(two, {
				answers: [{ choices: ["Sat"] }, undefined],
			}),
		).toBe(true);
		expect(
			checkQuestionnaireAnswer(two, {
				answers: [undefined, undefined],
				note: "ok",
			}),
		).toBe(true);
	});
	test("refuses a misaligned, empty or disallowed answer", () => {
		expect(
			checkQuestionnaireAnswer(two, { answers: [{ choices: ["Sat"] }] }),
		).toBe(false);
		expect(
			checkQuestionnaireAnswer(two, { answers: [undefined, undefined] }),
		).toBe(false);
		expect(
			checkQuestionnaireAnswer(two, {
				answers: [{ choices: ["Mon"] }, undefined],
			}),
		).toBe(false);
		expect(
			checkQuestionnaireAnswer(two, {
				answers: [
					undefined,
					{ choices: [], text: "x".repeat(L.answerChars + 1) },
				],
			}),
		).toBe(false);
	});
});

describe("shapeFor", () => {
	const previewed = set(
		q({
			header: "Day",
			options: [
				{ label: "Sat", preview: "plain" },
				{ label: "Sun", preview: "has ``` fence" },
				{ label: "Mon" },
			],
		}),
	);
	test("a single-question surface gets no header and no preview field", () => {
		const shaped = shapeFor(previewed, SINGLE_QUESTION).questions[0];
		expect(shaped).not.toHaveProperty("header");
		for (const option of shaped?.options ?? [])
			expect(option).not.toHaveProperty("preview");
	});
	test("previews are folded as fenced blocks, longer where the preview holds a fence", () => {
		const text = shapeFor(previewed, SINGLE_QUESTION).questions[0]?.question;
		expect(text).toContain("**Sat**\n```\nplain\n```");
		expect(text).toContain("**Sun**\n````\nhas ``` fence\n````");
		expect(text).not.toContain("**Mon**");
	});
	test("a folded question is cut to the question limit with an ellipsis", () => {
		const long = set(
			q({
				question: "x".repeat(1490),
				options: [{ label: "a", preview: "p".repeat(500) }],
			}),
		);
		const text = shapeFor(long, SINGLE_QUESTION).questions[0]?.question ?? "";
		expect(Array.from(text)).toHaveLength(L.questionChars);
		expect(text.endsWith("…")).toBe(true);
	});
	test("a surface with previews and several questions keeps everything", () => {
		expect(
			shapeFor(previewed, { questions: 4, previews: true, note: true }),
		).toEqual(previewed);
	});
	test("a surface without previews keeps the headers when it takes several questions", () => {
		const shaped = shapeFor(previewed, {
			questions: 4,
			previews: false,
			note: false,
		});
		expect(shaped.questions[0]?.header).toBe("Day");
	});
	test("a question without previews comes back unchanged", () => {
		const plain = set(q());
		expect(shapeFor(plain, SINGLE_QUESTION)).toEqual(plain);
	});
});

test("a 0.19-shaped Prompts still assigns to Prompts", () => {
	const old: Prompts = {
		confirm: async () => "expired",
		ask: async () => undefined,
	};
	expect(old.asks).toBeUndefined();
	expect(old.questionnaire).toBeUndefined();
});
