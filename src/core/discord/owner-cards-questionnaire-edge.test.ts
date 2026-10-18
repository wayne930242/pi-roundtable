import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import {
	QUESTIONNAIRE_LIMITS as L,
	type Questionnaire,
	validateQuestionnaire,
} from "../interactions/questionnaire.ts";
import { silentLogger } from "../log.ts";
import {
	messageViolations,
	modalViolations,
} from "../testing/discord-limits.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { CARD_PREFIX, type CardPayload, OwnerCards } from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

const custom = (id: string, action: string) => `${CARD_PREFIX}${id}:${action}`;
const two: Questionnaire = {
	questions: [
		{
			question: "Which day?",
			options: [{ label: "Sat" }, { label: "Sun" }],
			multi: false,
			allowOther: true,
		},
		{
			question: "Which food?",
			options: [{ label: "Rice" }, { label: "Bread" }],
			multi: true,
			allowOther: true,
		},
	],
};

function setup(thread = false, identity = false) {
	const fake = fakeChannel(thread);
	const cards = new OwnerCards({
		ownerId: OWNER,
		channel: fake.channel,
		logger: silentLogger(),
		...(identity ? { identity: mapIdentity({ owners: [OWNER] }) } : {}),
	});
	const ask = cards.prompts("discord:555")?.questionnaire;
	if (!ask) throw new Error("no questionnaire prompts");
	return { fake, cards, ask };
}

const all = (payload: CardPayload | undefined) =>
	payload?.components.map((c) => c.toJSON()) ?? [];

describe("a card whose texts are astral characters", () => {
	// Validation counts code points, discord.js counts UTF-16 units: 😀 is one and two.
	const emoji = (n: number) => "😀".repeat(n);
	const worst = (): Questionnaire => ({
		questions: Array.from({ length: 4 }, (_, q) => ({
			question: emoji(200),
			header: emoji(L.headerChars),
			options: Array.from({ length: L.options }, (_, o) => ({
				label: `${o}${emoji(L.labelChars - 2)}`,
				description: emoji(L.descriptionChars),
			})),
			multi: q % 2 === 0,
			allowOther: true,
		})),
	});

	test("posts, opens its form and draws every state within the builders' limits", async () => {
		for (const [thread, identity] of [
			[false, false],
			[true, true],
		] as const) {
			const { fake, cards, ask } = setup(thread, identity);
			const answer = ask("T", worst());
			await tick();
			// The card was posted: a throw in toJSON would have left it unposted.
			expect(fake.sent).toHaveLength(1);
			expect(messageViolations(all(fake.sent[0]))).toEqual([]);
			const id = fake.cardId();
			const pick = press("select", custom(id, "qpick:0"), {
				values: ["0", "24"],
			});
			await cards.handle(pick.interaction);
			expect(messageViolations(all(pick.edited[0]))).toEqual([]);
			const notes = press("button", custom(id, "notes"));
			await cards.handle(notes.interaction);
			const modal = (notes.modals[0] as { toJSON(): unknown }).toJSON();
			expect(modalViolations(modal)).toEqual([]);
			const submit = press("button", custom(id, "submit"));
			await cards.handle(submit.interaction);
			expect(messageViolations(all(submit.edited[0]))).toEqual([]);
			expect(await answer).toBeDefined();
		}
	});

	test("the helper counts UTF-16 units: code-point counting would pass what the builders refuse", () => {
		const label = emoji(60);
		expect(Array.from(label).length).toBeLessThanOrEqual(100);
		const select = { type: 3, options: [{ label, value: "0" }] };
		expect(messageViolations([{ type: 1, components: [select] }])[0]).toContain(
			"option label",
		);
	});
});

describe("a card that closed while a press was in flight", () => {
	async function closedMeanwhile(action: "pick" | "submit" | "form") {
		const { fake, cards, ask } = setup();
		const controller = new AbortController();
		const answer = ask("T", two, controller.signal);
		await tick();
		const id = fake.cardId();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const options = { gate, values: ["0"], fields: { t0: "mine", note: "n" } };
		const press1 =
			action === "pick"
				? press("select", custom(id, "qpick:0"), options)
				: action === "submit"
					? press("button", custom(id, "submit"), options)
					: press("modal", custom(id, "qtext"), options);
		const handled = cards.handle(press1.interaction);
		await tick();
		controller.abort();
		expect(await answer).toBeUndefined();
		release();
		await handled;
		return press1;
	}

	for (const action of ["pick", "submit", "form"] as const)
		test(`a ${action} finds the card closed: refused, nothing drawn open`, async () => {
			const result = await closedMeanwhile(action);
			expect(result.followUps[0]?.content).toBe(messages().cardInactive);
			expect(result.edited).toEqual([]);
		});
});

describe("the form submit", () => {
	test("is deferred before the audience is looked up, and a stranger changes nothing", async () => {
		const { fake, cards, ask } = setup();
		void ask("T", two);
		await tick();
		const id = fake.cardId();
		const stranger = press("modal", custom(id, "qtext"), {
			user: "1",
			fields: { t0: "x", note: "y" },
		});
		await cards.handle(stranger.interaction);
		expect(stranger.deferred).toEqual(["update"]);
		expect(stranger.followUps[0]?.content).toBe(messages().cardOwnerOnly);
		const own = press("button", custom(id, "submit"));
		await cards.handle(own.interaction);
		expect(own.followUps[0]?.content).toBe(messages().cardNothingYet);
		expect(json(fake.sent[0])).toContain(custom(id, "qpick:0"));
	});
});

describe("previews with many options on one question", () => {
	test("a single question with previews keeps Other… and its own-text semantics", async () => {
		const { fake, cards, ask } = setup();
		const answer = ask("T", {
			questions: [
				{
					question: "Which?",
					options: [{ label: "A", preview: "pa" }, { label: "B" }],
					multi: false,
					allowOther: true,
				},
			],
		});
		await tick();
		const id = fake.cardId();
		expect(json(fake.sent[0])).toContain(messages().cardOtherLabel);
		const other = press("select", custom(id, "pick"), { values: ["other"] });
		await cards.handle(other.interaction);
		expect(other.modals).toHaveLength(1);
		const text = press("modal", custom(id, "text"), { text: "mine" });
		await cards.handle(text.interaction);
		expect(await answer).toEqual({ answers: [{ choices: [], text: "mine" }] });
	});
});

describe("the previews attachment", () => {
	test("has its own text", async () => {
		const { fake, cards, ask } = setup();
		void ask("T", {
			questions: [
				{
					...(two.questions[0] ?? {
						question: "",
						options: [],
						multi: false,
						allowOther: false,
					}),
					options: [{ label: "A", preview: "```x```" }, { label: "B" }],
				},
			],
		});
		await tick();
		const open = press("button", custom(fake.cardId(), "previews"));
		await cards.handle(open.interaction);
		expect(open.replies[0]).toBe(messages().cardPreviewsFile);
	});
});

describe("the set budget counts UTF-16 units", () => {
	const set = (emojis: number): Questionnaire => ({
		questions: Array.from({ length: 4 }, (_, i) => ({
			question: `${i}${"😀".repeat(emojis)}`,
			options: [{ label: "a" }, { label: "b" }],
			multi: false,
			allowOther: false,
		})),
	});

	test("an emoji-heavy set at the budget is refused, telling the model an emoji counts as two", () => {
		// 4 × 375 code points = 1500 points, but 3000 units plus the digits: over 3000.
		const refused = validateQuestionnaire(set(375));
		expect(refused).toContain("counts as two");
	});

	test("a set just under the budget posts within Discord's limits", async () => {
		expect(validateQuestionnaire(set(370))).toBeUndefined();
		const { fake, ask } = setup();
		void ask("T", set(370));
		await tick();
		expect(fake.sent).toHaveLength(1);
		expect(messageViolations(all(fake.sent[0]))).toEqual([]);
	});
});
