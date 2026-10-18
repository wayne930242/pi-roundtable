import { describe, expect, test } from "bun:test";
import { FakeSurface } from "../examples/fake-surface.ts";
import type { Questionnaire } from "./core/interactions/questionnaire.ts";
import { askQuestions } from "./core/runtime/ask-questions.ts";
import { TEST_OWNER } from "./core/testing/owner.ts";

const set: Questionnaire = {
	questions: ["Type?", "Testing?", "Release?"].map((question) => ({
		question,
		options: [{ label: "a" }],
		multi: false,
		allowOther: true,
	})),
};

describe("the example surface, which keeps the one-question contract", () => {
	test("declares no questionnaire, so a set is asked one question at a time and stops at the first no answer", async () => {
		const surface = new FakeSurface();
		const prompts = surface.prompts("fake:room");
		expect(prompts.asks).toBeUndefined();
		expect(prompts.questionnaire).toBeUndefined();
		const text = await askQuestions(
			prompts,
			"infra",
			set,
			TEST_OWNER,
			undefined,
		);
		expect(text).toStartWith("1. Type?: No answer");
		expect(text).toContain("Not asked: 2. Testing?; 3. Release?;");
	});
});
