import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import type { OwnerQuestion } from "../interactions/prompts.ts";
import { silentLogger } from "../kernel/log.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { TEXT_FIELD } from "./owner-card-rows.ts";
import { CARD_PREFIX, type LateTurn, OwnerCards } from "./owner-cards.ts";
import { fakeChannel, OWNER, press, tick } from "./owner-cards-fixture.ts";

const STRANGER = "100000000000000009";

const question: OwnerQuestion = {
	question: "Which day?",
	options: [{ label: "Saturday" }, { label: "Sunday" }],
	multi: false,
	allowOther: true,
};

/**
 * An identity service whose every read, once `stall` is called, waits until `release`: a
 * database read that takes longer than Discord's three seconds. The card posts before it stalls.
 */
function stalledIdentity() {
	const real = mapIdentity({ owners: [OWNER] });
	let gate: Promise<void> = Promise.resolve();
	let release = () => {};
	const stall = () => {
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
	};
	const stalled = Object.fromEntries(
		Object.entries(real).map(([name, value]) => [
			name,
			typeof value === "function"
				? async (...args: unknown[]) => {
						await gate;
						return (value as (...a: unknown[]) => unknown)(...args);
					}
				: value,
		]),
	) as typeof real;
	return { identity: stalled, stall, release: () => release() };
}

function setup(
	identity?: ReturnType<typeof mapIdentity>,
	logger = silentLogger(),
) {
	const fake = fakeChannel(true);
	const resumed: LateTurn[] = [];
	const cards = new OwnerCards({
		ownerId: OWNER,
		...(identity ? { identity } : {}),
		channel: fake.channel,
		logger,
		resume: (turn) => resumed.push(turn),
	});
	const prompts = cards.prompts("discord:555");
	if (!prompts?.questionnaire) throw new Error("no prompts");
	return { fake, cards, prompts, resumed };
}

/** A thread whose parent is not cached, so reading it would be a fetch that never resolves. */
const uncached = { parentId: "700", forum: true, uncached: true };

describe("a card press answers Discord before anything that can take a while", () => {
	test("Write answer… shows its form first, with the thread uncached and the identity stalled", async () => {
		const { identity, stall, release } = stalledIdentity();
		const { fake, cards, prompts } = setup(identity);
		void prompts.ask("t", question);
		await tick();
		stall();
		const p = press("button", `${CARD_PREFIX}${fake.cardId()}:write`, {
			thread: uncached,
		});
		// Called, not awaited: the form must be shown before handle yields at all.
		const handled = cards.handle(p.interaction);
		expect(p.calls).toEqual(["showModal"]);
		release();
		await handled;
		expect(p.calls).toEqual(["showModal"]);
	});

	test("Other… in the menu shows its form first", async () => {
		const { identity, stall, release } = stalledIdentity();
		const { fake, cards, prompts } = setup(identity);
		void prompts.ask("t", question);
		await tick();
		stall();
		const p = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			values: ["other"],
			thread: uncached,
		});
		const handled = cards.handle(p.interaction);
		expect(p.calls).toEqual(["showModal"]);
		release();
		await handled;
	});

	test("a questionnaire's answer form shows first", async () => {
		const { identity, stall, release } = stalledIdentity();
		const { fake, cards, prompts } = setup(identity);
		void prompts.questionnaire?.("t", {
			questions: [question, { ...question, question: "Which time?" }],
		});
		await tick();
		stall();
		const p = press("button", `${CARD_PREFIX}${fake.cardId()}:notes`, {
			thread: uncached,
		});
		const handled = cards.handle(p.interaction);
		expect(p.calls).toEqual(["showModal"]);
		release();
		await handled;
	});

	test("an approval press is deferred first, then answered once the identity reads", async () => {
		const { identity, stall, release } = stalledIdentity();
		const { fake, cards, prompts } = setup(identity);
		const answer = prompts.confirm("t", "m");
		await tick();
		stall();
		const p = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			thread: uncached,
		});
		const handled = cards.handle(p.interaction);
		expect(p.calls).toEqual(["deferUpdate"]);
		release();
		await handled;
		expect(await answer).toBe("approved");
		expect(p.calls).toEqual(["deferUpdate", "editReply"]);
	});

	test("a menu pick and Cancel are deferred first", async () => {
		const { identity, stall, release } = stalledIdentity();
		const { fake, cards, prompts } = setup(identity);
		const answer = prompts.ask("t", question);
		await tick();
		const id = fake.cardId();
		stall();
		const pick = press("select", `${CARD_PREFIX}${id}:pick`, { values: ["1"] });
		const handled = cards.handle(pick.interaction);
		expect(pick.calls).toEqual(["deferUpdate"]);
		release();
		await handled;
		expect(await answer).toEqual({ choices: ["Sunday"] });
		expect(pick.calls).toEqual(["deferUpdate", "editReply"]);
		const late = press("button", `${CARD_PREFIX}${id}:cancel`);
		await cards.handle(late.interaction);
		expect(late.calls).toEqual(["reply"]);
	});

	test("someone the card is not for may open the form, but their answer is refused and changes nothing", async () => {
		const identity = mapIdentity({ owners: [OWNER] });
		const { fake, cards, prompts } = setup(identity);
		let settled = false;
		const answer = prompts.ask("t", question).then((value) => {
			settled = true;
			return value;
		});
		await tick();
		const id = fake.cardId();
		const open = press("button", `${CARD_PREFIX}${id}:write`, {
			user: STRANGER,
		});
		await cards.handle(open.interaction);
		expect(open.calls).toEqual(["showModal"]);
		const submit = press("modal", `${CARD_PREFIX}${id}:text`, {
			user: STRANGER,
			text: "Monday",
		});
		await cards.handle(submit.interaction);
		expect(submit.calls).toEqual(["deferUpdate", "followUp"]);
		expect(submit.followUps[0]?.content).toBe(messages().cardOwnerOnly);
		await tick();
		expect(settled).toBe(false);
		expect(fake.edits).toEqual([]);
		// The owner's own answer still ends it, without the stranger's picks.
		const owner = press("modal", `${CARD_PREFIX}${id}:text`, {
			fields: { [TEXT_FIELD]: "Sunday evening" },
		});
		await cards.handle(owner.interaction);
		expect(await answer).toEqual({ choices: [], text: "Sunday evening" });
	});

	test("a stranger's Other… pick does not become the owner's", async () => {
		const identity = mapIdentity({ owners: [OWNER] });
		const { fake, cards, prompts } = setup(identity);
		const answer = prompts.ask("t", question);
		await tick();
		const id = fake.cardId();
		await cards.handle(
			press("select", `${CARD_PREFIX}${id}:pick`, {
				user: STRANGER,
				values: ["0", "other"],
			}).interaction,
		);
		await cards.handle(
			press("button", `${CARD_PREFIX}${id}:write`).interaction,
		);
		await cards.handle(
			press("modal", `${CARD_PREFIX}${id}:text`, { text: "late" }).interaction,
		);
		expect(await answer).toEqual({ choices: [], text: "late" });
	});

	test("a late answer carries the thread the card was posted in, read when it was posted", async () => {
		const fake = fakeChannel(true);
		const resumed: LateTurn[] = [];
		const cards = new OwnerCards({
			ownerId: OWNER,
			channel: async () => ({
				...(await fake.channel()),
				parent: { parentId: "700", parentKind: "forum" },
			}),
			logger: silentLogger(),
			graceMs: 5,
			resume: (turn) => resumed.push(turn),
		});
		const prompts = cards.prompts("discord:555");
		expect(
			await prompts?.ask("t", question, undefined, { late: () => "late" }),
		).toBe("pending");
		await cards.handle(
			press("button", `${CARD_PREFIX}${fake.cardId()}:write`, {
				thread: uncached,
			}).interaction,
		);
		const p = press("modal", `${CARD_PREFIX}${fake.cardId()}:text`, {
			text: "x",
			thread: uncached,
		});
		await cards.handle(p.interaction);
		expect(p.calls).not.toContain("fetch");
		expect(resumed[0]?.thread).toEqual({
			parentId: "700",
			parentKind: "forum",
		});
	});

	test("each press is logged at debug with the card, the action and the time to its first response, never its content", async () => {
		const recorded = recordingLogger();
		const { fake, cards, prompts } = setup(
			mapIdentity({ owners: [OWNER] }),
			recorded.logger,
		);
		void prompts.ask("t", question);
		await tick();
		const id = fake.cardId();
		await cards.handle(
			press("modal", `${CARD_PREFIX}${id}:text`, { text: "secret words" })
				.interaction,
		);
		const line = recorded.lines.find((l) => l.message === "card press");
		expect(line?.level).toBe("debug");
		expect(line?.fields).toMatchObject({ cardId: id, action: "text" });
		expect(typeof line?.fields.firstResponseMs).toBe("number");
		expect(JSON.stringify(recorded.lines)).not.toContain("secret words");
	});
});
