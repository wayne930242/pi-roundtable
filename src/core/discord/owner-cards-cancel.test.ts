import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import { PRONOUNS } from "../identity.ts";
import type { LateAnswer, OwnerQuestion } from "../interactions/prompts.ts";
import type { Questionnaire } from "../interactions/questionnaire.ts";
import { silentLogger } from "../log.ts";
import { askQuestions } from "../runtime/ask-questions.ts";
import { messageViolations } from "../testing/discord-limits.ts";
import { CARD_PREFIX, type LateTurn, OwnerCards } from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

const day: OwnerQuestion = {
	question: "Which day?",
	options: [{ label: "Saturday" }, { label: "Sunday" }],
	multi: false,
	allowOther: true,
};
const food: OwnerQuestion = {
	question: "Which food?",
	options: [{ label: "Rice", preview: "**rice**" }, { label: "Noodles" }],
	multi: true,
	allowOther: false,
};
const owner = { name: "Riley", pronouns: PRONOUNS.they };

function setup(graceMs = 10_000) {
	const fake = fakeChannel();
	const resumed: LateTurn[] = [];
	const heard: LateAnswer[] = [];
	const cards = new OwnerCards({
		ownerId: OWNER,
		channel: fake.channel,
		logger: silentLogger(),
		graceMs,
		resume: (turn) => resumed.push(turn),
	});
	const prompts = cards.prompts("discord:555");
	if (!prompts) throw new Error("no prompts for a Discord channel");
	const wait = {
		late: (answer: LateAnswer) => {
			heard.push(answer);
			return `late: ${JSON.stringify(answer)}`;
		},
	};
	const cancel = (user?: string) =>
		press("button", `${CARD_PREFIX}${fake.cardId()}:cancel`, {
			...(user ? { user } : {}),
		});
	return { fake, cards, prompts, resumed, heard, wait, cancel };
}

const sets: [string, Questionnaire][] = [
	["one question", { questions: [day] }],
	["one question with previews", { questions: [food] }],
	["several questions", { questions: [day, food] }],
];

describe("Cancel on a question card", () => {
	for (const [name, set] of sets)
		test(`${name}: the card offers Cancel, and within the grace period the tool says it was declined`, async () => {
			const { fake, cards, prompts, resumed, cancel } = setup();
			const result = askQuestions(prompts, "blog", set, owner, undefined);
			await tick();
			expect(json(fake.sent[0])).toContain(messages().cardCancelLabel);
			expect(json(fake.sent[0])).toContain(`${fake.cardId()}:cancel`);
			expect(
				messageViolations(
					fake.sent[0]?.components.map((c) => c.toJSON()) ?? [],
				),
			).toEqual([]);
			const press = cancel();
			await cards.handle(press.interaction);
			const text = await result;
			expect(text).toContain("Riley cancelled the question");
			expect(text).toContain("Do not ask the same question again");
			expect(json(press.updates[0])).toContain(
				messages().cardQuestionCancelled,
			);
			expect(json(press.updates[0])).not.toContain('"disabled":false');
			expect(resumed).toEqual([]);
		});

	test("a single question resolves declined", async () => {
		const { cards, prompts, cancel } = setup();
		const answer = prompts.ask("t", day);
		await tick();
		await cards.handle(cancel().interaction);
		expect(await answer).toBe("declined");
	});

	test("only those who may answer can cancel", async () => {
		const { cards, prompts, cancel } = setup();
		const answer = prompts.ask("t", day);
		await tick();
		const stranger = cancel("100000000000000009");
		await cards.handle(stranger.interaction);
		expect(stranger.replies).toEqual([messages().cardOwnerOnly]);
		expect(stranger.updates).toEqual([]);
		await cards.handle(cancel().interaction);
		expect(await answer).toBe("declined");
	});

	test("a second press finds the card ended", async () => {
		const { cards, prompts, cancel } = setup();
		const answer = prompts.questionnaire?.("t", { questions: [day, food] });
		await tick();
		await cards.handle(cancel().interaction);
		const again = cancel();
		await cards.handle(again.interaction);
		expect(await answer).toBe("declined");
		expect(again.replies).toEqual([messages().cardInactive]);
		expect(again.updates).toEqual([]);
	});

	for (const [name, set] of sets)
		test(`${name}: after the grace period Cancel only closes the card`, async () => {
			const { fake, cards, prompts, resumed, heard, wait, cancel } = setup(10);
			const answer =
				set === sets[0]?.[1]
					? prompts.ask("t", day, undefined, wait)
					: prompts.questionnaire?.("t", set, undefined, wait);
			expect(await answer).toBe("pending");
			const press = cancel();
			await cards.handle(press.interaction);
			expect(json(press.updates[0])).toContain(
				messages().cardQuestionCancelled,
			);
			expect(json(press.updates[0])).not.toContain('"disabled":false');
			expect(resumed).toEqual([]);
			expect(heard).toEqual([]);
			// Nothing is left pending: a later press finds the card ended.
			const again = cancel();
			await cards.handle(again.interaction);
			expect(again.replies).toEqual([messages().cardInactive]);
			expect(fake.edits).toEqual([]);
			expect(resumed).toEqual([]);
		});
});
