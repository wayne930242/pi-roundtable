import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import type { OwnerQuestion } from "../interactions/prompts.ts";
import { silentLogger } from "../log.ts";
import { CARD_PREFIX, OwnerCards } from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

const custom = (id: string, action: string) => `${CARD_PREFIX}${id}:${action}`;

describe("a single-question card with 25 options and an answer of their own", () => {
	test("keeps all 25 options and offers the form as a button", async () => {
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const question: OwnerQuestion = {
			question: "Pick",
			options: Array.from({ length: 25 }, (_, i) => ({ label: `o${i}` })),
			multi: false,
			allowOther: true,
		};
		const answer = cards.prompts("discord:555")?.ask("t", question);
		await tick();
		const text = json(fake.sent[0]);
		expect(text).toContain('"label":"o24"');
		expect(text).not.toContain(messages().cardOtherLabel);
		expect(text).toContain(`${CARD_PREFIX}${fake.cardId()}:write`);
		const write = press("button", custom(fake.cardId(), "write"));
		await cards.handle(write.interaction);
		expect(write.modals).toHaveLength(1);
		await cards.handle(
			press("modal", custom(fake.cardId(), "text"), { text: "mine" })
				.interaction,
		);
		expect(await answer).toEqual({ choices: [], text: "mine" });
	});
});
