import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { YesNoQuestion } from "../domain/ports.ts";
import { TEST_OWNER as OWNER } from "../testing/owner.ts";
import type { Agent } from "./agent-store.ts";
import { mentionedMembers, planRound, RelevanceScorer } from "./group-round.ts";

const agent = (name: string, displayName: string): Agent => ({
	name,
	displayName,
	prompt: `You are ${displayName}.`,
	avatarPrompt: "",
	status: "active",
});
const members = [
	agent("coordinator", "Координатор"),
	agent("infra", "Infra"),
	agent("doctor", "Bot Доктор"),
];
const logger = pino({ level: "silent" });

describe("mentionedMembers", () => {
	test("matches display names and names, ignoring case", () => {
		expect(mentionedMembers("@Bot Доктор what do you think", members)).toEqual([
			"doctor",
		]);
		expect(
			mentionedMembers("@infra and @Координатор take a look", members),
		).toEqual(["coordinator", "infra"]);
	});

	test("does not match a longer word", () => {
		expect(mentionedMembers("@infrastructure", members)).toEqual([]);
		expect(mentionedMembers("infra hello", members)).toEqual([]);
	});
});

describe("planRound", () => {
	const names = members.map((m) => m.name);

	test("members above the threshold answer, most relevant last", () => {
		expect(
			planRound({
				members: names,
				host: "coordinator",
				scores: { coordinator: 0.6, infra: 0.95, doctor: 0.2 },
				forced: new Set(),
			}),
		).toEqual(["coordinator", "infra"]);
	});

	test("a forced member answers whatever its score, in score order", () => {
		expect(
			planRound({
				members: names,
				host: "coordinator",
				scores: { coordinator: 0.1, infra: 0.9, doctor: 0.05 },
				forced: new Set(["doctor"]),
			}),
		).toEqual(["doctor", "infra"]);
	});

	test("ties keep group order", () => {
		expect(
			planRound({
				members: names,
				host: "coordinator",
				scores: { coordinator: 0.7, infra: 0.7, doctor: 0.7 },
				forced: new Set(),
			}),
		).toEqual(names);
	});

	test("with nobody qualifying the host answers alone", () => {
		expect(
			planRound({
				members: names,
				host: "infra",
				scores: { coordinator: 0.1, infra: 0.2, doctor: 0.3 },
				forced: new Set(),
			}),
		).toEqual(["infra"]);
	});

	test("without scores only forced members answer, or the host", () => {
		expect(
			planRound({
				members: names,
				host: "coordinator",
				scores: undefined,
				forced: new Set(["doctor"]),
			}),
		).toEqual(["doctor"]);
		expect(
			planRound({
				members: names,
				host: "coordinator",
				scores: undefined,
				forced: new Set(),
			}),
		).toEqual(["coordinator"]);
	});
});

describe("RelevanceScorer", () => {
	test("asks one question per member in one request and maps the answers back", async () => {
		const asked: Record<string, YesNoQuestion>[] = [];
		const scorer = new RelevanceScorer(
			{
				askYesNo: async (_state, questions) => {
					asked.push(questions);
					return { m_coordinator: 0.3, m_infra: 0.9, m_doctor: 0.1 };
				},
			},
			logger,
			OWNER,
		);
		expect(await scorer.score(members, [], "the disk is almost full")).toEqual({
			coordinator: 0.3,
			infra: 0.9,
			doctor: 0.1,
		});
		expect(asked).toHaveLength(1);
		expect(Object.keys(asked[0] ?? {})).toEqual([
			"m_coordinator",
			"m_infra",
			"m_doctor",
		]);
	});

	test("a failed request yields no scores", async () => {
		const scorer = new RelevanceScorer(
			{
				askYesNo: async () => {
					throw new Error("down");
				},
			},
			logger,
			OWNER,
		);
		expect(await scorer.score(members, [], "hi")).toBeUndefined();
	});
});
