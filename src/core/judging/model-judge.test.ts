import { describe, expect, test } from "bun:test";
import { JudgeError } from "../errors.ts";
import { type JudgeModel, ModelJudge } from "./model-judge.ts";

/** A model that answers each prompt with the next scripted text and records the prompts. */
function scripted(...answers: string[]): {
	model: JudgeModel;
	prompts: string[];
} {
	const prompts: string[] = [];
	return {
		prompts,
		model: async (_system, prompt) => {
			prompts.push(prompt);
			const answer = answers.shift();
			if (answer === undefined) throw new Error("no scripted answer left");
			return answer;
		},
	};
}

/** What the promise rejected with; undefined when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

const approval = {
	approves: {
		type: "yesno" as const,
		instructions: "Does the reply approve the held actions?",
		criteria: { true: "the owner agrees", false: "the owner declines" },
	},
};

describe("ModelJudge", () => {
	test("a yes-or-no answer gives each question's probability, and the prompt carries the state", async () => {
		const { model, prompts } = scripted('{"approves": 0.92}');
		const judge = new ModelJudge(model);
		expect(
			await judge.askYesNo({ reply: "sounds good, send it" }, approval),
		).toEqual({
			approves: 0.92,
		});
		expect(prompts[0]).toContain('"reply": "sounds good, send it"');
		expect(prompts[0]).toContain("Yes means: the owner agrees.");
		// A bare "how sure are you" made a model rate its own certainty, so a clear no scored 0.99.
		expect(prompts[0]).toContain("probability that the answer is yes");
	});

	test("a code fence or words around the object are tolerated", async () => {
		const { model } = scripted('Sure:\n```json\n{"approves": 0.1}\n```');
		expect(await new ModelJudge(model).askYesNo({}, approval)).toEqual({
			approves: 0.1,
		});
	});

	test("a missing or out-of-range probability throws", async () => {
		const { model } = scripted('{"other": 1}', '{"approves": 1.5}', "no JSON");
		const judge = new ModelJudge(model);
		for (let i = 0; i < 3; i++)
			expect(await rejection(judge.askYesNo({}, approval))).toBeInstanceOf(
				JudgeError,
			);
	});

	test("a choice must name a listed option with a confidence", async () => {
		const question = {
			type: "choice" as const,
			instructions: "Which expression fits the reply?",
			criteria: { happy: "cheerful", neutral: "plain" },
		};
		const { model } = scripted(
			'{"choice": "happy", "confidence": 0.8}',
			'{"choice": "angry", "confidence": 0.8}',
			'{"choice": "neutral"}',
		);
		const judge = new ModelJudge(model);
		expect(await judge.askChoice({}, "expression", question)).toEqual({
			choice: "happy",
			confidence: 0.8,
		});
		expect(
			await rejection(judge.askChoice({}, "expression", question)),
		).toBeInstanceOf(JudgeError);
		expect(
			await rejection(judge.askChoice({}, "expression", question)),
		).toBeInstanceOf(JudgeError);
	});

	test("a score gives one probability per level, normalized to sum to one", async () => {
		const question = {
			type: "score" as const,
			instructions: "How much thinking does the turn need?",
			criteria: ["low", "medium", "high"],
		};
		const { model } = scripted(
			'{"probabilities": [0.2, 0.2, 0.4]}',
			'{"probabilities": [0.5, 0.5]}',
			'{"probabilities": [0, 0, 0]}',
		);
		const judge = new ModelJudge(model);
		expect(await judge.askScore({}, "effort", question)).toEqual([
			0.25, 0.25, 0.5,
		]);
		expect(
			await rejection(judge.askScore({}, "effort", question)),
		).toBeInstanceOf(JudgeError);
		expect(
			await rejection(judge.askScore({}, "effort", question)),
		).toBeInstanceOf(JudgeError);
	});

	test("a failing model's error reaches the caller", async () => {
		const judge = new ModelJudge(async () => {
			throw new Error("offline");
		});
		expect(String(await rejection(judge.askYesNo({}, approval)))).toContain(
			"offline",
		);
	});
});
