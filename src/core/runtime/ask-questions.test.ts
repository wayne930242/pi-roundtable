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

	test("while the host stops, no card is posted and a waiting one is reported lost", async () => {
		const stopped = v2({ answers: [{ choices: ["Bug"] }] });
		const refused = await askQuestions(
			stopped.prompts,
			"infra",
			two,
			OWNER,
			undefined,
			() => true,
		);
		expect(refused).toStartWith(
			"The server is restarting, so no card was posted",
		);
		expect(stopped.sent).toHaveLength(0);

		// The drain begins while the card waits: its "stays open" would not hold.
		let stopping = false;
		const waiting: Prompts = {
			...v2("pending").prompts,
			questionnaire: async () => {
				stopping = true;
				return "pending";
			},
		};
		const lost = await askQuestions(
			waiting,
			"infra",
			two,
			OWNER,
			undefined,
			() => stopping,
		);
		expect(lost).toContain("the server is restarting");
		expect(lost).not.toContain("The card stays open");

		const one = v1(["pending"]);
		let asked = false;
		const single: Prompts = {
			...one.prompts,
			ask: async (...args) => {
				asked = true;
				return one.prompts.ask(...args);
			},
		};
		const singleLost = await askQuestions(
			single,
			"infra",
			{ questions: [two.questions[0] as Questionnaire["questions"][number]] },
			OWNER,
			undefined,
			() => asked,
		);
		expect(singleLost).toContain("the server is restarting");
		// Answered before the drain, the answer stands.
		expect(
			await askQuestions(
				v2({ answers: [{ choices: ["Bug"] }, undefined, undefined] }).prompts,
				"infra",
				two,
				OWNER,
				undefined,
				() => false,
			),
		).toContain("1. Type: chose Bug");
	});

	describe("in a yolo conversation", () => {
		const yolo = (
			prompts: Prompts,
			q: Questionnaire,
			stopping?: () => boolean,
		) => askQuestions(prompts, "infra", q, OWNER, undefined, stopping, 30_000);
		const keepWorking = (text: string) => {
			expect(text).toContain("Riley has not answered yet, and yolo mode is on");
			expect(text).toContain("do not end your turn and do not ask again");
			expect(text).toContain("Go on with your recommended option");
			expect(text).toContain("say in your reply what you assumed");
			expect(text).toContain("Only a question that truly blocks");
			expect(text).not.toContain("End your turn now");
		};

		test("a questionnaire card waits the turn's short grace and pending says to keep working", async () => {
			const pending = v2("pending");
			keepWorking(await yolo(pending.prompts, two));
			expect(pending.waits[0]?.graceMs).toBe(30_000);
			// The late answer still starts a turn with it.
			expect(
				pending.waits[0]?.late({
					kind: "questionnaire",
					answer: { answers: [{ choices: ["Bug"] }, undefined, undefined] },
					by: "Ada",
				}),
			).toContain("1. Type: chose Bug");
		});

		test("one question asked on its own, and the first of several asked one at a time, say the same", async () => {
			const one = v1(["pending"]);
			keepWorking(
				await yolo(one.prompts, {
					questions: [two.questions[0] as Questionnaire["questions"][number]],
				}),
			);
			expect(one.waits[0]?.graceMs).toBe(30_000);
			const several = v1([{ choices: ["Bug"] }, "pending"]);
			const text = await yolo(several.prompts, two);
			expect(text).toContain("1. Type: chose Bug");
			keepWorking(text);
			expect(several.waits.map((w) => w.graceMs)).toEqual([30_000, 30_000]);
		});

		test("an answer, a cancel and no answer read as outside yolo", async () => {
			expect(
				await yolo(
					v2({ answers: [{ choices: ["Bug"] }, undefined, undefined] }).prompts,
					two,
				),
			).toContain("1. Type: chose Bug");
			expect(await yolo(v2(undefined).prompts, two)).toStartWith("No answer");
		});

		test("the restart still wins: no card while the host stops, and a waiting one is lost", async () => {
			const stopped = v2("pending");
			expect(await yolo(stopped.prompts, two, () => true)).toStartWith(
				"The server is restarting, so no card was posted",
			);
			expect(stopped.sent).toHaveLength(0);
			let stopping = false;
			const waiting: Prompts = {
				...v2("pending").prompts,
				questionnaire: async () => {
					stopping = true;
					return "pending";
				},
			};
			const lost = await yolo(waiting, two, () => stopping);
			expect(lost).toContain("the server is restarting");
			expect(lost).not.toContain("yolo mode is on");
		});

		test("outside yolo the wait has no grace of its own and pending ends the turn", async () => {
			const pending = v2("pending");
			const text = await run(pending.prompts, two);
			expect(text).toContain("End your turn now");
			expect(pending.waits[0]?.graceMs).toBeUndefined();
		});
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
		// The same text as a 0.19 single-question answer.
		expect(await run(withPreviews.prompts, one)).toBe("Riley chose: a");
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

	test("a late answer to one question with previews reads exactly as 0.19's", async () => {
		const one: Questionnaire = {
			questions: [
				{
					question: "Which day?",
					options: [{ label: "Saturday", preview: "x" }, { label: "Sunday" }],
					multi: false,
					allowOther: true,
				},
			],
		};
		const open = v2("pending");
		await run(open.prompts, one);
		expect(
			open.waits[0]?.late({
				kind: "questionnaire",
				answer: {
					answers: [{ choices: ["Sunday"], text: "after lunch" }],
				},
				by: "Ada",
			}),
		).toBe(
			"(Ada answered your earlier ask_user question on its card, after your turn had ended. Continue from where you stopped, with this answer.)\nQuestion: Which day?\nAda chose: Sunday\nAda wrote: after lunch",
		);
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
			expect(text).toStartWith("1. Type: No answer");
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
