import { describe, expect, test } from "bun:test";
import type { Judge, ScoreQuestion } from "../contract/providers.ts";
import { JudgeError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import {
	AGENT_BRIEF,
	EffortJudge,
	levelIndex,
	moveIndex,
} from "./effort-judge.ts";

class FakeJudge implements Judge {
	constructor(private readonly scores: number[] | Error) {}
	async askYesNo(): Promise<Record<string, number>> {
		throw new Error("not used here");
	}
	async askChoice(): Promise<never> {
		throw new Error("not used here");
	}
	scored: { state: Record<string, unknown>; criteria: readonly string[] }[] =
		[];
	async askScore(
		state: Record<string, unknown>,
		_name: string,
		question: ScoreQuestion,
	): Promise<number[]> {
		this.scored.push({ state, criteria: question.criteria });
		if (this.scores instanceof Error) throw this.scores;
		return this.scores;
	}
}

describe("EffortJudge", () => {
	type Level = "low" | "medium" | "high" | "xhigh";
	const judge = (
		scores: number[] | Error,
		previous: { reply?: string; level?: Level } = {},
		fallback: Level = "low",
	) => {
		const fakeJudge = new FakeJudge(scores);
		const level = new EffortJudge({
			judge: fakeJudge,
			brief: AGENT_BRIEF,
			fallback,
			threshold: 0.6,
			logger: silentLogger(),
		}).judge("sounds good, go ahead", previous);
		return { level, fakeJudge };
	};

	test("a first turn takes the median of the judge's distribution up to high", async () => {
		expect(await judge([0.9, 0.1, 0, 0]).level).toBe("low");
		expect(await judge([0.2, 0.6, 0.2, 0]).level).toBe("medium");
		expect(await judge([0, 0.1, 0.9, 0]).level).toBe("high");
	});

	test("xhigh takes a near-certain answer, otherwise it stays high", async () => {
		expect(await judge([0, 0, 0.1, 0.9]).level).toBe("xhigh");
		expect(await judge([0, 0, 0.3, 0.7]).level).toBe("high");
		expect(await judge([0, 0, 0.3, 0.7], { level: "high" }).level).toBe("high");
	});

	test("a split first answer lands where the mass is, not in the middle", () => {
		expect(levelIndex([0.6, 0, 0.4, 0])).toBe(0);
		expect(levelIndex([0.4, 0, 0.6, 0])).toBe(2);
	});

	test("an unsure answer keeps the previous turn's level", async () => {
		expect(await judge([0.4, 0.15, 0.45, 0], { level: "high" }).level).toBe(
			"high",
		);
		expect(await judge([0.45, 0.1, 0.45, 0], { level: "low" }).level).toBe(
			"low",
		);
	});

	test("a confident answer moves off the previous level either way", async () => {
		expect(await judge([0, 0.3, 0.7, 0], { level: "low" }).level).toBe("high");
		expect(await judge([0.55, 0.45, 0, 0], { level: "high" }).level).toBe(
			"medium",
		);
		expect(await judge([0.9, 0.1, 0, 0], { level: "high" }).level).toBe("low");
	});

	test("moveIndex checks upgrades before downgrades", () => {
		expect(moveIndex(1, [0.5, 0, 0.5, 0], 0.5)).toBe(2);
	});

	test("a judge failure keeps the previous level, or runs at the fallback", async () => {
		expect(await judge(new JudgeError("down")).level).toBe("low");
		expect(await judge(new JudgeError("down"), {}, "medium").level).toBe(
			"medium",
		);
		expect(
			await judge(new JudgeError("down"), { level: "high" }, "medium").level,
		).toBe("high");
	});

	test("the judge reads the previous reply with the message and the brief's rubric", async () => {
		const { level, fakeJudge } = judge([1, 0, 0, 0], {
			reply: "Plan: move the database first, then switch DNS.",
		});
		await level;
		expect(fakeJudge.scored[0]).toEqual({
			state: {
				message: "sounds good, go ahead",
				previous_reply: "Plan: move the database first, then switch DNS.",
			},
			criteria: AGENT_BRIEF.criteria,
		});
	});
});
