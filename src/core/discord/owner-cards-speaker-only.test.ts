import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import type { IdentityLink } from "../identity/principal-store.ts";
import {
	type ApprovedBy,
	type LateAnswer,
	promptScope,
} from "../interactions/prompts.ts";
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

const ADA = "100000000000000002";
const SAM = "100000000000000005";
const CY = "100000000000000004";

const identity = mapIdentity({
	owners: [OWNER],
	admins: { users: [ADA, SAM] },
	members: { users: [CY] },
});

const sam: Speaker = { id: SAM, name: "Sam", tier: "admin", principalId: SAM };
const cy: Speaker = { id: CY, name: "Cy", tier: "member", principalId: CY };
const owner: Speaker = {
	id: OWNER,
	name: "Owner",
	tier: "owner",
	principalId: OWNER,
};

function setup(who: typeof identity | null = identity) {
	const fake = fakeChannel(true);
	const cards = new OwnerCards({
		ownerId: OWNER,
		...(who ? { identity: who } : {}),
		channel: fake.channel,
		logger: silentLogger(),
		resume: () => undefined,
		graceMs: 20,
	});
	const approvals: ApprovedBy[] = [];
	const late: LateAnswer[] = [];
	const ask = (
		speaker: Speaker | undefined,
		options: {
			speakerOnly?: boolean;
			approvers?: readonly string[];
			minTier?: Speaker["tier"];
			visibility?: "private" | "shared";
			withWait?: boolean;
		} = {},
	) =>
		cards
			.prompts(
				"discord:555",
				speaker && promptScope(speaker, options.visibility),
			)
			?.confirm(
				"t",
				"**book**",
				undefined,
				options.minTier ?? "member",
				options.withWait
					? {
							late: (answer) => {
								late.push(answer);
								return undefined;
							},
						}
					: undefined,
				undefined,
				{
					...(options.speakerOnly ? { speakerOnly: true } : {}),
					...(options.approvers ? { approvers: options.approvers } : {}),
					approvedBy: (by) => approvals.push(by),
				},
			);
	const pressAs = async (user: string, action: "yes" | "no" = "yes") => {
		const pressed = press(
			"button",
			`${CARD_PREFIX}${fake.cardId()}:${action}`,
			{ user },
		);
		await cards.handle(pressed.interaction);
		return pressed.replies;
	};
	return { fake, ask, pressAs, approvals, late };
}

describe("a card that is its speaker's alone", () => {
	test("the speaker's press approves it, and an owner's press is refused with the card's line", async () => {
		const { fake, ask, pressAs, approvals } = setup();
		const answer = ask(sam, { speakerOnly: true });
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${SAM}>`);
		expect(json(fake.sent[0])).not.toContain(`<@${OWNER}>`);
		expect(await pressAs(OWNER)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(ADA)).toEqual([messages().cardApproversRefusal]);
		expect(approvals).toEqual([]);
		expect(await pressAs(SAM)).toEqual([]);
		expect(await answer).toBe("approved");
		expect(approvals).toEqual([
			{ principalId: SAM, speakerId: SAM, name: SAM },
		]);
	});

	test("an owner's decline is refused too, so the card stays open for the speaker", async () => {
		const { ask, pressAs } = setup();
		const answer = ask(sam, { speakerOnly: true });
		await tick();
		expect(await pressAs(OWNER, "no")).toEqual([
			messages().cardApproversRefusal,
		]);
		expect(await pressAs(SAM, "no")).toEqual([]);
		expect(await answer).toBe("declined");
	});

	test("the same card without the option is still the owners' to answer", async () => {
		const { ask, pressAs } = setup();
		const answer = ask(sam);
		await tick();
		expect(await pressAs(OWNER)).toEqual([]);
		expect(await answer).toBe("approved");
	});

	test("a speaker below the call's tier gets it unavailable at once, shown to no one", async () => {
		const { fake, ask } = setup();
		expect(await ask(cy, { speakerOnly: true, minTier: "admin" })).toBe(
			"unavailable",
		);
		expect(fake.sent).toEqual([]);
	});

	test("a turn with no speaker gets it unavailable at once", async () => {
		const { fake, ask } = setup();
		expect(await ask(undefined, { speakerOnly: true })).toBe("unavailable");
		expect(fake.sent).toEqual([]);
	});

	test("a speaker whose tier fell while the card was open may no longer answer", async () => {
		let demoted = false;
		const { ask, pressAs } = setup({
			...identity,
			resolve: async (facts) => {
				const speaker = await identity.resolve(facts);
				return speaker && demoted && speaker.id === SAM
					? { ...speaker, tier: "member" }
					: speaker;
			},
		});
		const answer = ask(sam, { speakerOnly: true, minTier: "admin" });
		await tick();
		demoted = true;
		expect(await pressAs(SAM)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(SAM, "no")).toEqual([messages().cardApproversRefusal]);
		// Nobody may end it now but the turn; stop the wait with the grace period of the test.
		void answer;
	});

	test("an identity moved to someone else after the card was posted may not answer it", async () => {
		let moved = false;
		const { ask, pressAs } = setup({
			...identity,
			identities: async (principalId): Promise<IdentityLink[]> =>
				principalId === SAM && moved
					? []
					: [...(await identity.identities(principalId))],
		});
		const answer = ask(sam, { speakerOnly: true });
		await tick();
		moved = true;
		expect(await pressAs(SAM)).toEqual([messages().cardApproversRefusal]);
		void answer;
	});

	test("an owner who is the speaker answers their own card, and anyone else is refused", async () => {
		const { fake, ask, pressAs, approvals } = setup();
		const answer = ask(owner, { speakerOnly: true });
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${OWNER}>`);
		expect(await pressAs(SAM)).toEqual([messages().cardOwnerOnly]);
		expect(await pressAs(OWNER)).toEqual([]);
		expect(await answer).toBe("approved");
		expect(approvals).toEqual([
			{ principalId: OWNER, speakerId: OWNER, name: OWNER, owner: true },
		]);
	});

	test("without an identity service only the primary owner is a speaker", async () => {
		const { ask, pressAs } = setup(null);
		expect(await ask(sam, { speakerOnly: true })).toBe("unavailable");
		const answer = ask(owner, { speakerOnly: true });
		await tick();
		expect(await pressAs(SAM)).toEqual([messages().cardOwnerOnly]);
		expect(await pressAs(OWNER)).toEqual([]);
		expect(await answer).toBe("approved");
	});

	test("it ignores approvers: the card is still the speaker's, and named approvers get no say", async () => {
		const { fake, ask, pressAs } = setup();
		const answer = ask(sam, { speakerOnly: true, approvers: [ADA] });
		await tick();
		expect(json(fake.sent[0])).not.toContain(`<@${ADA}>`);
		expect(await pressAs(ADA)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(OWNER)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(SAM)).toEqual([]);
		expect(await answer).toBe("approved");
	});

	test("a late press by an owner is refused, and the speaker's late press is taken", async () => {
		const { ask, pressAs, late } = setup();
		const pending = ask(sam, { speakerOnly: true, withWait: true });
		expect(await pending).toBe("pending");
		expect(await pressAs(OWNER)).toEqual([messages().cardApproversRefusal]);
		expect(late).toEqual([]);
		expect(await pressAs(SAM)).toEqual([]);
		expect(late.map((answer) => answer.kind)).toEqual(["approval"]);
	});
});
