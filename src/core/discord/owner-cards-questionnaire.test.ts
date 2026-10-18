import { afterEach, describe, expect, jest, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import type { LateAnswer } from "../interactions/prompts.ts";
import {
	QUESTIONNAIRE_LIMITS as L,
	type OwnerQuestion,
	type Questionnaire,
	type QuestionnaireAnswer,
} from "../interactions/questionnaire.ts";
import { silentLogger } from "../log.ts";
import {
	messageViolations,
	modalViolations,
} from "../testing/discord-limits.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import {
	CARD_PREFIX,
	type CardPayload,
	type LateTurn,
	OwnerCards,
} from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

const day: OwnerQuestion = {
	question: "Which day?",
	header: "Day",
	options: [{ label: "Saturday" }, { label: "Sunday" }],
	multi: false,
	allowOther: true,
};
const food: OwnerQuestion = {
	question: "Which food?",
	options: [{ label: "Rice" }, { label: "Noodles" }, { label: "Bread" }],
	multi: true,
	allowOther: false,
};
const set: Questionnaire = { questions: [day, food] };

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
	if (!prompts?.questionnaire) throw new Error("no questionnaire prompts");
	const wait = {
		late: (answer: LateAnswer) => {
			heard.push(answer);
			return "late";
		},
	};
	return {
		fake,
		cards,
		prompts,
		ask: prompts.questionnaire,
		resumed,
		heard,
		wait,
	};
}

const custom = (id: string, action: string) => `${CARD_PREFIX}${id}:${action}`;

afterEach(() => jest.useRealTimers());

/** Moves the fake clock and lets the promises it settles run. */
async function advance(ms: number) {
	jest.advanceTimersByTime(ms);
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** The first node in a card's JSON that satisfies `match`. */
function find(
	node: unknown,
	match: (n: Record<string, unknown>) => boolean,
): unknown {
	if (typeof node !== "object" || node === null) return undefined;
	if (match(node as Record<string, unknown>)) return node;
	for (const child of Object.values(node)) {
		const hit = find(child, match);
		if (hit) return hit;
	}
	return undefined;
}

describe("the Discord questionnaire card", () => {
	test("declares four questions, previews and a note", () => {
		expect(setup().prompts.asks).toEqual({
			questions: 4,
			previews: true,
			note: true,
		});
	});

	test("posts one card: a menu per question with options, Submit, the form button, and a footer outside the container", async () => {
		const { fake, ask } = setup();
		void ask("Questions", set);
		await tick();
		const card = fake.sent[0];
		const [container, footer] = card?.components.map((c) => c.toJSON()) ?? [];
		expect(container).toMatchObject({ type: 17 });
		expect(footer).toMatchObject({
			type: 10,
			content: `-# ${messages().cardQuestionnaireFooter(0, 2)}`,
		});
		const text = json(card);
		expect(text).toContain("**1 · Day**");
		expect(text).toContain(custom(fake.cardId(), "qpick:0"));
		expect(text).toContain(custom(fake.cardId(), "qpick:1"));
		expect(text).toContain(custom(fake.cardId(), "submit"));
		expect(text).toContain(custom(fake.cardId(), "notes"));
		// No previews in this set, so no Previews button.
		expect(text).not.toContain(":previews");
		expect(
			messageViolations(card?.components.map((c) => c.toJSON()) ?? []),
		).toEqual([]);
	});

	test("picks update a shared draft for everyone who sees the card; the menus show it", async () => {
		const { fake, cards, ask } = setup();
		void ask("Questions", set);
		await tick();
		const id = fake.cardId();
		const pick = press("select", custom(id, "qpick:1"), { values: ["0", "2"] });
		await cards.handle(pick.interaction);
		expect(pick.deferred).toEqual(["update"]);
		const shown = JSON.stringify(
			pick.edited[0]?.components.map((c) => c.toJSON()),
		);
		expect(shown).toContain(messages().cardQuestionnaireFooter(1, 2));
		// "Rice" and "Bread" are the defaults of question 2's menu.
		const menu = find(
			pick.edited[0]?.components.map((c) => c.toJSON()),
			(n) => n.custom_id === custom(id, "qpick:1"),
		);
		expect(menu).toMatchObject({
			min_values: 0,
			options: [
				{ label: "Rice", default: true },
				{ label: "Noodles", default: false },
				{ label: "Bread", default: true },
			],
		});
	});

	test("Submit answers with what was chosen and written; a blank question is undefined", async () => {
		const { fake, cards, ask } = setup();
		const answer = ask("Questions", set);
		await tick();
		const id = fake.cardId();
		await cards.handle(
			press("select", custom(id, "qpick:1"), { values: ["1"] }).interaction,
		);
		const form = press("modal", custom(id, "qtext"), {
			fields: { t0: " on a rainy day ", note: "thanks" },
		});
		await cards.handle(form.interaction);
		expect(json(form.edited[0])).toContain(
			messages().cardQuestionnaireFooter(2, 2),
		);
		const submit = press("button", custom(id, "submit"));
		await cards.handle(submit.interaction);
		expect(await answer).toEqual({
			answers: [
				{ choices: [], text: "on a rainy day" },
				{ choices: ["Noodles"] },
			],
			note: "thanks",
		} satisfies QuestionnaireAnswer);
		const closed = json(submit.edited[0]);
		expect(closed).toContain('"disabled":true');
		expect(closed).toContain("Noodles");
		expect(closed).toContain("rainy day");
		expect(closed).toContain(messages().cardNoteLine("thanks"));
	});

	test("a partial answer is allowed", async () => {
		const { fake, cards, ask } = setup();
		const answer = ask("Questions", set);
		await tick();
		const id = fake.cardId();
		await cards.handle(
			press("select", custom(id, "qpick:0"), { values: ["1"] }).interaction,
		);
		await cards.handle(press("button", custom(id, "submit")).interaction);
		expect(await answer).toEqual({
			answers: [{ choices: ["Sunday"] }, undefined],
		});
	});

	test("Submit with nothing chosen or written is refused, and the card stays open", async () => {
		const { fake, cards, ask } = setup();
		void ask("Questions", set);
		await tick();
		const submit = press("button", custom(fake.cardId(), "submit"));
		await cards.handle(submit.interaction);
		expect(submit.followUps[0]?.content).toBe(messages().cardNothingYet);
		expect(submit.edited).toEqual([]);
		expect(fake.edits).toEqual([]);
	});

	test("someone who may not answer is refused and the draft is unchanged", async () => {
		const { fake, cards, ask } = setup();
		const answer = ask("Questions", set);
		await tick();
		const id = fake.cardId();
		const stranger = press("select", custom(id, "qpick:0"), {
			user: "1",
			values: ["0"],
		});
		await cards.handle(stranger.interaction);
		expect(stranger.followUps[0]?.content).toBe(messages().cardOwnerOnly);
		// Their own menu is reset by re-drawing the card, which still holds no pick.
		expect(stranger.edited).toHaveLength(1);
		expect(json(stranger.edited[0])).not.toContain('"default":true');
		const noSubmit = press("button", custom(id, "submit"), { user: "1" });
		await cards.handle(noSubmit.interaction);
		expect(noSubmit.followUps[0]?.content).toBe(messages().cardOwnerOnly);
		const notes = press("button", custom(id, "notes"), { user: "1" });
		await cards.handle(notes.interaction);
		expect(notes.replies).toEqual([messages().cardOwnerOnly]);
		expect(notes.modals).toEqual([]);
		// The owner's Submit finds nothing in the draft: the stranger's pick did not count.
		const own = press("button", custom(id, "submit"));
		await cards.handle(own.interaction);
		expect(own.followUps[0]?.content).toBe(messages().cardNothingYet);
		void answer;
	});

	test("Previews open for anyone, answer nothing, and carry every preview", async () => {
		const { fake, cards, ask } = setup();
		const answer = ask("Questions", {
			questions: [
				{
					...day,
					options: [
						{ label: "Saturday", preview: "SAT-PREVIEW" },
						{ label: "Sunday", preview: "SUN-PREVIEW" },
					],
				},
				food,
			],
		});
		await tick();
		const id = fake.cardId();
		expect(json(fake.sent[0])).toContain(custom(id, "previews"));
		const stranger = press("button", custom(id, "previews"), { user: "1" });
		await cards.handle(stranger.interaction);
		const shown = JSON.stringify(stranger.replied);
		expect(shown).toContain("SAT-PREVIEW");
		expect(shown).toContain("SUN-PREVIEW");
		expect(stranger.updates).toEqual([]);
		// The card is still open: the owner answers it.
		await cards.handle(
			press("select", custom(id, "qpick:0"), { values: ["0"] }).interaction,
		);
		await cards.handle(press("button", custom(id, "submit")).interaction);
		expect(await answer).toEqual({
			answers: [{ choices: ["Saturday"] }, undefined],
		});
	});

	test("previews holding a code fence are sent as a file", async () => {
		const { fake, cards, ask } = setup();
		void ask("Questions", {
			questions: [
				{
					...day,
					options: [
						{ label: "Saturday", preview: "```js\nx\n```" },
						{ label: "Sunday" },
					],
				},
			],
		});
		await tick();
		const open = press("button", custom(fake.cardId(), "previews"));
		await cards.handle(open.interaction);
		expect(open.replied[0]?.files).toHaveLength(1);
	});

	test("one question with previews is the single-question card plus a Previews button", async () => {
		const { fake, cards, ask } = setup();
		const answer = ask("Questions", {
			questions: [
				{
					...day,
					allowOther: false,
					options: [{ label: "Saturday", preview: "P" }, { label: "Sunday" }],
				},
			],
		});
		await tick();
		const id = fake.cardId();
		expect(json(fake.sent[0])).not.toContain(":submit");
		expect(json(fake.sent[0])).not.toContain(":notes");
		expect(json(fake.sent[0])).toContain(custom(id, "previews"));
		const plainOne = fakeChannel();
		void new OwnerCards({
			ownerId: OWNER,
			channel: plainOne.channel,
			logger: silentLogger(),
		})
			.prompts("discord:555")
			?.questionnaire?.("t", {
				questions: [{ ...day, options: [{ label: "x" }], allowOther: false }],
			});
		await tick();
		expect(json(plainOne.sent[0])).not.toContain(":previews");
		const preview = press("button", custom(id, "previews"), { user: "1" });
		await cards.handle(preview.interaction);
		expect(JSON.stringify(preview.replied)).toContain("P");
		const pick = press("select", custom(id, "pick"), { values: ["1"] });
		await cards.handle(pick.interaction);
		expect(await answer).toEqual({ answers: [{ choices: ["Sunday"] }] });
		expect(json(pick.updates[0])).toContain('"disabled":true');
	});

	test("a draft edit restarts the grace period of a turn that waits on the card", async () => {
		jest.useFakeTimers();
		const { fake, cards, ask, wait } = setup(1_000);
		let settled: unknown;
		const answer = ask("Questions", set, undefined, wait).then((a) => {
			settled = a;
		});
		await Promise.resolve();
		await advance(0);
		const id = fake.cardId();
		await advance(900);
		await cards.handle(
			press("select", custom(id, "qpick:0"), { values: ["0"] }).interaction,
		);
		// 900 + 900 ms is past the first period, but the pick restarted it.
		await advance(900);
		expect(settled).toBeUndefined();
		await advance(200);
		await answer;
		expect(settled).toBe("pending");
	});

	test("without an edit the grace period ends on time (counter-proof of the restart test)", async () => {
		jest.useFakeTimers();
		const { fake, ask, wait } = setup(1_000);
		let settled: unknown;
		void ask("Questions", set, undefined, wait).then((a) => {
			settled = a;
		});
		await advance(0);
		await advance(900);
		expect(fake.sent).toHaveLength(1);
		expect(settled).toBeUndefined();
		await advance(200);
		expect(settled).toBe("pending");
	});

	test("a Submit after the grace period starts a turn with the questionnaire answer", async () => {
		jest.useRealTimers();
		const { fake, cards, ask, resumed, heard, wait } = setup(5);
		expect(await ask("Questions", set, undefined, wait)).toBe("pending");
		const id = fake.cardId();
		await cards.handle(
			press("select", custom(id, "qpick:0"), { values: ["0"] }).interaction,
		);
		const submit = press("button", custom(id, "submit"));
		await cards.handle(submit.interaction);
		expect(heard).toEqual([
			{
				kind: "questionnaire",
				by: OWNER,
				answer: { answers: [{ choices: ["Saturday"] }, undefined] },
			},
		]);
		expect(resumed).toHaveLength(1);
		expect(json(submit.edited[0])).toContain('"disabled":true');
		// A second Submit finds the card answered.
		const again = press("button", custom(id, "submit"));
		await cards.handle(again.interaction);
		expect(again.replies).toEqual([messages().cardInactive]);
		expect(resumed).toHaveLength(1);
	});

	test("an old single-question card still answers while a questionnaire is open", async () => {
		const { fake, cards, prompts, ask } = setup();
		const single = prompts.ask("Q", day);
		await tick();
		const singleId = fake.cardId();
		void ask("Questions", set);
		await tick();
		const pick = press("select", custom(singleId, "pick"), { values: ["1"] });
		await cards.handle(pick.interaction);
		expect(await single).toEqual({ choices: ["Sunday"] });
		expect(pick.updates).toHaveLength(1);
	});

	test("a stopped turn cancels its questionnaire card", async () => {
		const { fake, ask } = setup();
		const controller = new AbortController();
		const answer = ask("Questions", set, controller.signal);
		await tick();
		controller.abort();
		expect(await answer).toBeUndefined();
		expect(json(fake.edits[0])).toContain(messages().cardStopped);
	});

	test("with the identity service the card is the asker's: a second speaker is refused", async () => {
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			channel: fake.channel,
			logger: silentLogger(),
			identity: mapIdentity({ owners: [OWNER] }),
		});
		const ask = cards.prompts("discord:555")?.questionnaire;
		void ask?.("Questions", set);
		await tick();
		const stranger = press("button", custom(fake.cardId(), "submit"), {
			user: "1",
		});
		await cards.handle(stranger.interaction);
		expect(stranger.followUps).toHaveLength(1);
	});
});

describe("the worst case fits Discord's limits", () => {
	const chars = (n: number, c = "x") => c.repeat(n);
	const worst: Questionnaire = {
		questions: Array.from({ length: 4 }, (_, q) => ({
			question: chars(Math.floor((L.setChars - 4 * L.headerChars) / 4), "q"),
			header: chars(L.headerChars, "h"),
			options: Array.from({ length: L.options }, (_, o) => ({
				label: `${o}`.padEnd(L.labelChars, "l"),
				description: chars(L.descriptionChars, "d"),
				preview: chars(L.previewChars, "p"),
			})),
			multi: q % 2 === 0,
			allowOther: true,
		})),
	};

	test("the open card, the filled card, the closed card and the form", async () => {
		const { fake, cards, ask } = setup();
		void ask("T".repeat(80), worst);
		await tick();
		const id = fake.cardId();
		const all = (payload: CardPayload | undefined) =>
			payload?.components.map((c) => c.toJSON()) ?? [];
		expect(messageViolations(all(fake.sent[0]))).toEqual([]);
		for (const q of [0, 1, 2, 3]) {
			const values = Array.from({ length: L.options }, (_, n) => String(n));
			const pick = press("select", custom(id, `qpick:${q}`), {
				values: worst.questions[q]?.multi ? values : ["24"],
			});
			await cards.handle(pick.interaction);
			expect(messageViolations(all(pick.edited[0]))).toEqual([]);
		}
		const notes = press("button", custom(id, "notes"));
		await cards.handle(notes.interaction);
		const modal = (notes.modals[0] as { toJSON(): unknown }).toJSON();
		expect(modalViolations(modal)).toEqual([]);
		const full = chars(L.answerChars, "a");
		const form = press("modal", custom(id, "qtext"), {
			fields: { t0: full, t1: full, t2: full, t3: full, note: full },
		});
		await cards.handle(form.interaction);
		expect(messageViolations(all(form.edited[0]))).toEqual([]);
		// With the filled draft the form opens prefilled, still within its limits.
		const again = press("button", custom(id, "notes"));
		await cards.handle(again.interaction);
		expect(
			modalViolations((again.modals[0] as { toJSON(): unknown }).toJSON()),
		).toEqual([]);
		const submit = press("button", custom(id, "submit"));
		await cards.handle(submit.interaction);
		expect(messageViolations(all(submit.edited[0]))).toEqual([]);
		expect(json(submit.edited[0])).toContain('"disabled":true');
	});

	test("the limits helper catches a card over a limit (counter-proof)", () => {
		const child = { type: 10, content: "x" };
		const container = { type: 17, components: Array(11).fill(child) };
		expect(messageViolations([container])[0]).toContain("11 children");
		expect(
			messageViolations([{ type: 10, content: "x".repeat(4001) }])[0],
		).toContain("4001");
		const select = {
			type: 3,
			options: Array(26).fill({ label: "a", value: "a" }),
		};
		expect(messageViolations([{ type: 1, components: [select] }])[0]).toContain(
			"26 options",
		);
		expect(
			modalViolations({
				title: "t",
				components: Array(6).fill({ type: 18 }),
			})[0],
		).toContain("6 components");
		expect(
			modalViolations({ title: "t".repeat(46), components: [] })[0],
		).toContain("title");
	});
});
