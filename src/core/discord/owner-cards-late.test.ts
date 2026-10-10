import { describe, expect, test } from "bun:test";
import { cardsEn, cardsZhTW } from "../i18n/cards.ts";
import { messages } from "../i18n/index.ts";
import type { LateAnswer, OwnerQuestion } from "../interactions/prompts.ts";
import { silentLogger } from "../log.ts";
import { CARD_PREFIX, type LateTurn, OwnerCards } from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

const question: OwnerQuestion = {
	question: "Which day?",
	options: [{ label: "Saturday" }, { label: "Sunday" }],
	multi: false,
	allowOther: false,
};

function setup(graceMs = 10) {
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
	return { fake, cards, prompts, resumed, heard, wait };
}

describe("OwnerCards after the grace period", () => {
	test("an answer within the grace period continues the turn and starts none", async () => {
		const { fake, cards, prompts, resumed, wait } = setup(1_000);
		const answer = prompts.confirm("t", "m", undefined, undefined, wait);
		await tick();
		const yes = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`);
		await cards.handle(yes.interaction);
		expect(await answer).toBe("approved");
		expect(resumed).toEqual([]);
	});

	test("an unanswered approval goes on as pending and its card stays open, unedited", async () => {
		const { fake, prompts, wait } = setup();
		expect(await prompts.confirm("t", "m", undefined, undefined, wait)).toBe(
			"pending",
		);
		await tick();
		expect(fake.edits).toEqual([]);
		expect(json(fake.sent[0])).toContain('"disabled":false');
	});

	test("a late approval starts one turn as the answerer's message; a second press finds it answered", async () => {
		const { fake, cards, prompts, resumed, heard, wait } = setup();
		await prompts.confirm("t", "m", undefined, undefined, wait);
		const id = fake.cardId();
		const yes = press("button", `${CARD_PREFIX}${id}:yes`);
		await cards.handle(yes.interaction);
		expect(heard).toEqual([{ kind: "approval", approved: true, by: OWNER }]);
		expect(resumed).toEqual([
			{
				channelId: "555",
				messageId: "400000000000000004",
				user: { id: OWNER, name: OWNER, roleIds: [] },
				guildId: "300000000000000003",
				isDirect: false,
				text: `late: ${JSON.stringify(heard[0])}`,
			},
		]);
		expect(json(yes.updates[0])).toContain(messages().cardApproved);
		expect(json(yes.updates[0])).toContain('"disabled":true');
		const again = press("button", `${CARD_PREFIX}${id}:yes`);
		await cards.handle(again.interaction);
		expect(again.replies).toEqual([messages().cardInactive]);
		expect(resumed).toHaveLength(1);
		expect(heard).toHaveLength(1);
	});

	test("a late refusal starts a turn that says so", async () => {
		const { fake, cards, prompts, resumed, heard, wait } = setup();
		await prompts.confirm("t", "m", undefined, undefined, wait);
		const no = press("button", `${CARD_PREFIX}${fake.cardId()}:no`);
		await cards.handle(no.interaction);
		expect(heard).toEqual([{ kind: "approval", approved: false, by: OWNER }]);
		expect(resumed).toHaveLength(1);
		expect(json(no.updates[0])).toContain(messages().cardDeclined);
	});

	test("a late question's answer starts a turn with the answer", async () => {
		const { fake, cards, prompts, resumed, heard, wait } = setup();
		expect(await prompts.ask("t", question, undefined, wait)).toBe("pending");
		const pick = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			values: ["1"],
		});
		await cards.handle(pick.interaction);
		expect(heard).toEqual([
			{ kind: "question", answer: { choices: ["Sunday"] }, by: OWNER },
		]);
		expect(resumed[0]?.text).toContain("Sunday");
		expect(json(pick.updates[0])).toContain(
			messages().cardAnswered(["Sunday"]),
		);
	});

	test("a stop within the grace period cancels the card; after it the card stays the conversation's", async () => {
		const early = setup(1_000);
		const stop = new AbortController();
		const answer = early.prompts.confirm(
			"t",
			"m",
			stop.signal,
			undefined,
			early.wait,
		);
		await tick();
		stop.abort();
		expect(await answer).toBe("cancelled");
		await tick();
		expect(json(early.fake.edits[0])).toContain(messages().cardStopped);

		const later = setup();
		const after = new AbortController();
		expect(
			await later.prompts.confirm(
				"t",
				"m",
				after.signal,
				undefined,
				later.wait,
			),
		).toBe("pending");
		after.abort();
		await tick();
		expect(later.fake.edits).toEqual([]);
		const yes = press("button", `${CARD_PREFIX}${later.fake.cardId()}:yes`);
		await later.cards.handle(yes.interaction);
		expect(later.resumed).toHaveLength(1);
	});

	test("a late answer whose turn has nothing to say starts none", async () => {
		const { fake, cards, prompts, resumed } = setup();
		await prompts.confirm("t", "m", undefined, undefined, {
			late: () => undefined,
		});
		await cards.handle(
			press("button", `${CARD_PREFIX}${fake.cardId()}:yes`).interaction,
		);
		expect(resumed).toEqual([]);
	});
});

test("no card says how long it has left, in either language", () => {
	const context = { assistant: "Pi" } as Parameters<typeof cardsEn>[0];
	for (const catalog of [cardsEn(context), cardsZhTW(context)]) {
		const text = JSON.stringify(
			Object.values(catalog).map((entry) =>
				typeof entry === "function"
					? (entry as (...args: unknown[]) => string)(["x"])
					: entry,
			),
		);
		expect(text).not.toMatch(
			/\d+ ?(minutes?|\u5206\u9418)|timed out|\u903e\u6642/i,
		);
	}
});
