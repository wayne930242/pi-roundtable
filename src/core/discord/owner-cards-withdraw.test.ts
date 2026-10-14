import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import type { LateAnswer } from "../interactions/prompts.ts";
import { silentLogger } from "../log.ts";
import { CARD_PREFIX, type LateTurn, OwnerCards } from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

function setup(graceMs = 1_000) {
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
			return "late";
		},
	};
	/** A card for a call its plugin may withdraw. */
	const ask = (supersede: AbortSignal, withWait = true) =>
		prompts.confirm(
			"t",
			"m",
			undefined,
			undefined,
			withWait ? wait : undefined,
			undefined,
			{ supersede },
		);
	return { fake, cards, prompts, resumed, heard, ask };
}

describe("a card whose plugin withdraws the call", () => {
	test("closes while its turn waits: controls off, the reason as footer, the turn told it was cancelled", async () => {
		const { fake, ask } = setup();
		const withdraw = new AbortController();
		const answer = ask(withdraw.signal);
		await tick();
		expect(json(fake.sent[0])).toContain('"disabled":false');
		withdraw.abort("replaced by a newer request");
		expect(await answer).toBe("cancelled");
		expect(fake.edits).toHaveLength(1);
		expect(json(fake.edits[0])).toContain('"disabled":true');
		expect(json(fake.edits[0])).toContain("replaced by a newer request");
	});

	test("without a text reason the footer says the call was withdrawn", async () => {
		const { fake, ask } = setup();
		const withdraw = new AbortController();
		const answer = ask(withdraw.signal);
		await tick();
		withdraw.abort();
		await answer;
		expect(json(fake.edits[0])).toContain(messages().cardWithdrawn);
	});

	test("closes after the turn stopped waiting, editing the card and starting no turn", async () => {
		const { fake, cards, ask, resumed, heard } = setup(5);
		const withdraw = new AbortController();
		expect(await ask(withdraw.signal)).toBe("pending");
		const id = fake.cardId();
		expect(fake.edits).toEqual([]);
		withdraw.abort("no longer needed");
		await tick();
		expect(fake.edits).toHaveLength(1);
		expect(json(fake.edits[0])).toContain('"disabled":true');
		expect(json(fake.edits[0])).toContain("no longer needed");
		// A press on the closed card is refused and answers nothing.
		const yes = press("button", `${CARD_PREFIX}${id}:yes`);
		await cards.handle(yes.interaction);
		expect(yes.replies).toEqual([messages().cardInactive]);
		expect(yes.updates).toEqual([]);
		expect(heard).toEqual([]);
		expect(resumed).toEqual([]);
	});

	test("a card answered first stays answered: the withdrawal changes nothing", async () => {
		const { fake, cards, ask } = setup();
		const withdraw = new AbortController();
		const answer = ask(withdraw.signal);
		await tick();
		const yes = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`);
		await cards.handle(yes.interaction);
		withdraw.abort("too late");
		expect(await answer).toBe("approved");
		expect(fake.edits).toEqual([]);
		expect(json(yes.updates[0])).toContain(messages().cardApproved);
	});

	test("a card answered late first starts its turn once, and the withdrawal after it edits nothing", async () => {
		const { fake, cards, ask, resumed } = setup(5);
		const withdraw = new AbortController();
		await ask(withdraw.signal);
		const yes = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`);
		await cards.handle(yes.interaction);
		withdraw.abort();
		await tick();
		expect(resumed).toHaveLength(1);
		expect(fake.edits).toEqual([]);
	});

	test("a press that is being checked when the plugin withdraws is refused, and starts nothing", async () => {
		const { fake, cards, ask, resumed, heard } = setup(5);
		const withdraw = new AbortController();
		await ask(withdraw.signal);
		const id = fake.cardId();
		const yes = press("button", `${CARD_PREFIX}${id}:yes`);
		// The press passed its first look at the card; the plugin withdraws before it is applied.
		const handling = cards.handle(yes.interaction);
		withdraw.abort();
		await handling;
		expect(yes.replies).toEqual([messages().cardInactive]);
		expect(yes.updates).toEqual([]);
		expect(heard).toEqual([]);
		expect(resumed).toEqual([]);
	});

	test("withdrawing twice, or after the turn cancelled the card, edits once", async () => {
		const { fake, ask } = setup();
		const withdraw = new AbortController();
		const stop = new AbortController();
		const answer = ask(withdraw.signal);
		await tick();
		withdraw.abort("first");
		withdraw.abort("second");
		await answer;
		stop.abort();
		await tick();
		expect(fake.edits).toHaveLength(1);
		expect(json(fake.edits[0])).toContain("first");
	});

	test("a signal that is already aborted posts no card", async () => {
		const { fake, ask } = setup();
		const withdraw = new AbortController();
		withdraw.abort();
		expect(await ask(withdraw.signal)).toBe("cancelled");
		expect(fake.sent).toEqual([]);
	});

	test("a reason of markdown or a mention is shown as plain text", async () => {
		const { fake, ask } = setup();
		const withdraw = new AbortController();
		const answer = ask(withdraw.signal);
		await tick();
		withdraw.abort("line one\nline two");
		await answer;
		expect(json(fake.edits[0])).toContain("line one line two");
	});

	test("a card that was answered leaves nothing listening to the signal", async () => {
		const { fake, cards, ask } = setup();
		const withdraw = new AbortController();
		let listeners = 0;
		const add = withdraw.signal.addEventListener.bind(withdraw.signal);
		const remove = withdraw.signal.removeEventListener.bind(withdraw.signal);
		withdraw.signal.addEventListener = (...args: Parameters<typeof add>) => {
			listeners++;
			add(...args);
		};
		withdraw.signal.removeEventListener = (
			...args: Parameters<typeof remove>
		) => {
			listeners--;
			remove(...args);
		};
		const answer = ask(withdraw.signal);
		await tick();
		expect(listeners).toBe(1);
		const no = press("button", `${CARD_PREFIX}${fake.cardId()}:no`);
		await cards.handle(no.interaction);
		await answer;
		expect(listeners).toBe(0);
	});
});
