import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import { type PromptScope, promptScope } from "../interactions/prompts.ts";
import { silentLogger } from "../log.ts";
import type { Speaker } from "../speakers.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { CARD_PREFIX, OwnerCards } from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

const SECOND_OWNER = "100000000000000006";
const ADMIN = "100000000000000002";

/** Two owners, as the CLI may grant a second one; the second has a principal of their own. */
const identity = mapIdentity({
	owners: [OWNER, SECOND_OWNER],
	admins: { users: [ADMIN] },
});

const second: Speaker = {
	id: SECOND_OWNER,
	name: "Sam",
	tier: "owner",
	principalId: SECOND_OWNER,
};
const admin: Speaker = {
	id: ADMIN,
	name: "Ada",
	tier: "admin",
	principalId: ADMIN,
};

/** Cards in a thread, where they mention whom they are for. */
function cardsInThread() {
	const fake = fakeChannel(true);
	const cards = new OwnerCards({
		ownerId: OWNER,
		identity,
		channel: fake.channel,
		logger: silentLogger(),
	});
	const approval = (
		scope: PromptScope | undefined,
		minTier?: Speaker["tier"],
	) =>
		cards
			.prompts("discord:555", scope)
			?.confirm("t", "**rm**", undefined, minTier);
	const pressAs = async (user: string, action: "yes" | "no" = "yes") => {
		const pressed = press(
			"button",
			`${CARD_PREFIX}${fake.cardId()}:${action}`,
			{
				user,
			},
		);
		await cards.handle(pressed.interaction);
		return pressed.replies;
	};
	return { fake, cards, approval, pressAs };
}

describe("cards by the prompt scope", () => {
	test("another owner may approve their own owner-tier call in a shared conversation; the primary owner too", async () => {
		const own = cardsInThread();
		const answer = own.approval(promptScope(second));
		await tick();
		expect(json(own.fake.sent[0])).toContain(`<@${SECOND_OWNER}>`);
		expect(json(own.fake.sent[0])).toContain(
			messages().cardApproversNote(SECOND_OWNER),
		);
		expect(own.fake.sent[0]?.allowedMentions).toEqual({
			users: [SECOND_OWNER],
		});
		expect(await own.pressAs(ADMIN)).toEqual([messages().cardApproversRefusal]);
		expect(await own.pressAs(SECOND_OWNER)).toEqual([]);
		expect(await answer).toBe("approved");
		const primary = cardsInThread();
		const declined = primary.approval(promptScope(second));
		await tick();
		expect(await primary.pressAs(OWNER, "no")).toEqual([]);
		expect(await declined).toBe("declined");
	});

	test("a shared conversation's call above the speaker's tier goes to every owner: the card mentions them, and the second owner approves it", async () => {
		const { fake, approval, pressAs } = cardsInThread();
		const answer = approval(promptScope(admin));
		await tick();
		const sent = json(fake.sent[0]);
		expect(sent).toContain(`<@${OWNER}> <@${SECOND_OWNER}>`);
		expect(sent).not.toContain(`<@${ADMIN}>`);
		expect(fake.sent[0]?.allowedMentions).toEqual({
			users: [OWNER, SECOND_OWNER],
		});
		expect(await pressAs(ADMIN)).toEqual([messages().cardOwnerOnly]);
		expect(await pressAs(SECOND_OWNER)).toEqual([]);
		expect(await answer).toBe("approved");
	});

	test("an owner revoked while the card is open may no longer approve it", async () => {
		let revoked = false;
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity: {
				...identity,
				resolve: async (facts) => {
					const speaker = await identity.resolve(facts);
					return speaker && revoked && speaker.id === SECOND_OWNER
						? { ...speaker, tier: "admin" }
						: speaker;
				},
			},
			channel: fake.channel,
			logger: silentLogger(),
		});
		void cards.prompts("discord:555", promptScope(admin))?.confirm("t", "m");
		await tick();
		revoked = true;
		const pressed = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: SECOND_OWNER,
		});
		await cards.handle(pressed.interaction);
		expect(pressed.replies).toEqual([messages().cardOwnerOnly]);
	});

	test("a private conversation's call above the speaker's tier expires at once, and no card is posted", async () => {
		const { fake, approval } = cardsInThread();
		expect(await approval(promptScope(admin, "private"))).toBe("expired");
		expect(fake.sent).toEqual([]);
	});

	test("in a private conversation only its person answers: an owner may not approve or answer for them", async () => {
		const { fake, cards, approval, pressAs } = cardsInThread();
		const answer = approval(promptScope(admin, "private"), "admin");
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${ADMIN}>`);
		expect(await pressAs(OWNER)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(SECOND_OWNER)).toEqual([
			messages().cardApproversRefusal,
		]);
		expect(await pressAs(ADMIN)).toEqual([]);
		expect(await answer).toBe("approved");
		const question = cards
			.prompts("discord:555", promptScope(admin, "private"))
			?.ask("t", {
				question: "Which one?",
				options: [{ label: "First" }],
				multi: false,
				allowOther: false,
			});
		await tick();
		const owner = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			user: OWNER,
			values: ["0"],
		});
		await cards.handle(owner.interaction);
		expect(owner.replies).toEqual([messages().cardAskerRefusal]);
		const own = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			user: ADMIN,
			values: ["0"],
		});
		await cards.handle(own.interaction);
		expect(await question).toEqual({ choices: ["First"] });
	});

	test("a question in a report turn, whose speaker no one can press as, is for the owners", async () => {
		const { fake, cards } = cardsInThread();
		void cards
			.prompts(
				"discord:555",
				promptScope({
					id: "assistant",
					name: "assistant",
					tier: "owner",
					principalId: "assistant",
				}),
			)
			?.ask("t", {
				question: "Retry?",
				options: [],
				multi: false,
				allowOther: false,
			});
		await tick();
		const sent = json(fake.sent[0]);
		expect(sent).toContain(`<@${OWNER}> <@${SECOND_OWNER}>`);
		expect(sent).not.toContain("<@assistant>");
	});
});
