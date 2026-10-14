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
const BO = "100000000000000003";
const CY = "100000000000000004";
const SAM = "100000000000000005";
const STRANGER = "100000000000000009";

const identity = mapIdentity({
	owners: [OWNER],
	admins: { users: [ADA, BO, SAM] },
	members: { users: [CY] },
});

/** Sam speaks: an admin, in a conversation others share. */
const sam: Speaker = { id: SAM, name: "Sam", tier: "admin", principalId: SAM };

function setup(who: typeof identity = identity) {
	const fake = fakeChannel(true);
	const cards = new OwnerCards({
		ownerId: OWNER,
		identity: who,
		channel: fake.channel,
		logger: silentLogger(),
		resume: () => undefined,
		graceMs: 20,
	});
	const approvals: ApprovedBy[] = [];
	const late: LateAnswer[] = [];
	const approval = (
		approvers: readonly string[] | undefined,
		visibility: "private" | "shared" = "shared",
		minTier: Speaker["tier"] = "admin",
		withWait = false,
	) =>
		cards.prompts("discord:555", promptScope(sam, visibility))?.confirm(
			"t",
			"**send**",
			undefined,
			minTier,
			withWait
				? {
						late: (answer) => {
							late.push(answer);
							return undefined;
						},
					}
				: undefined,
			undefined,
			{
				...(approvers ? { approvers } : {}),
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
	return { fake, cards, approval, pressAs, approvals, late };
}

describe("cards for a call that names its approvers", () => {
	test("the named approver approves it instead of the speaker, and is reported as the approver", async () => {
		const { fake, approval, pressAs, approvals } = setup();
		const answer = approval([ADA]);
		await tick();
		const sent = json(fake.sent[0]);
		expect(sent).toContain(`<@${ADA}>`);
		expect(sent).not.toContain(`<@${SAM}>`);
		expect(fake.sent[0]?.allowedMentions).toEqual({ users: [ADA] });
		expect(await pressAs(SAM)).toEqual([messages().cardNamedApproversRefusal]);
		expect(await pressAs(BO)).toEqual([messages().cardNamedApproversRefusal]);
		expect(await pressAs(STRANGER)).toEqual([
			messages().cardNamedApproversRefusal,
		]);
		expect(approvals).toEqual([]);
		expect(await pressAs(ADA)).toEqual([]);
		expect(await answer).toBe("approved");
		expect(approvals).toEqual([
			{ principalId: ADA, speakerId: ADA, name: ADA },
		]);
	});

	test("every named approver is mentioned and may answer, and a refusal reports no one", async () => {
		const { fake, approval, pressAs, approvals } = setup();
		const answer = approval([ADA, BO]);
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${ADA}> <@${BO}>`);
		expect(await pressAs(BO, "no")).toEqual([]);
		expect(await answer).toBe("declined");
		expect(approvals).toEqual([]);
	});

	test("the speaker answers it only when named", async () => {
		const { approval, pressAs } = setup();
		const answer = approval([ADA, SAM]);
		await tick();
		expect(await pressAs(SAM)).toEqual([]);
		expect(await answer).toBe("approved");
	});

	test("an owner may still approve it, and is reported as the approver", async () => {
		const { approval, pressAs, approvals } = setup();
		const answer = approval([ADA]);
		await tick();
		expect(await pressAs(OWNER)).toEqual([]);
		expect(await answer).toBe("approved");
		expect(approvals).toEqual([
			{ principalId: OWNER, speakerId: OWNER, name: OWNER, owner: true },
		]);
	});

	test("a named approver below the call's tier is refused when they press", async () => {
		const { approval, pressAs, approvals } = setup();
		const answer = approval([CY], "shared", "admin");
		await tick();
		expect(await pressAs(CY)).toEqual([messages().cardNamedApproversRefusal]);
		expect(approvals).toEqual([]);
		await pressAs(OWNER, "no");
		expect(await answer).toBe("declined");
	});

	test("an approver whose tier fell while the card was open may no longer answer", async () => {
		let demoted = false;
		const { approval, pressAs } = setup({
			...identity,
			resolve: async (facts) => {
				const speaker = await identity.resolve(facts);
				return speaker && demoted && speaker.id === ADA
					? { ...speaker, tier: "member" }
					: speaker;
			},
		});
		const answer = approval([ADA]);
		await tick();
		demoted = true;
		expect(await pressAs(ADA)).toEqual([messages().cardNamedApproversRefusal]);
		await pressAs(OWNER, "no");
		expect(await answer).toBe("declined");
	});

	test("an empty set leaves the card to the owners, which the speaker may not answer", async () => {
		const { fake, approval, pressAs } = setup();
		const answer = approval([]);
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${OWNER}>`);
		expect(json(fake.sent[0])).not.toContain(`<@${SAM}>`);
		expect(await pressAs(SAM)).toEqual([messages().cardOwnerOnly]);
		expect(await pressAs(ADA)).toEqual([messages().cardOwnerOnly]);
		expect(await pressAs(OWNER)).toEqual([]);
		expect(await answer).toBe("approved");
	});

	test("approvers none of whom has a Discord identity leave the card to the owners", async () => {
		const { fake, approval, pressAs } = setup();
		const answer = approval(["p_without_discord"]);
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${OWNER}>`);
		expect(await pressAs(ADA)).toEqual([messages().cardOwnerOnly]);
		await pressAs(OWNER);
		expect(await answer).toBe("approved");
	});

	test("an identity moved to someone else after the card was posted may not answer it", async () => {
		let moved = false;
		const { approval, pressAs } = setup({
			...identity,
			identities: async (principalId): Promise<IdentityLink[]> =>
				principalId === ADA && moved
					? []
					: [...(await identity.identities(principalId))],
		});
		const answer = approval([ADA]);
		await tick();
		moved = true;
		expect(await pressAs(ADA)).toEqual([messages().cardNamedApproversRefusal]);
		await pressAs(OWNER, "no");
		expect(await answer).toBe("declined");
	});

	test("a private conversation whose person is not named is refused: the card is unavailable and shown to no one", async () => {
		const { fake, approval } = setup();
		// Sam, an admin who holds the tier, asked; only Ada is named, and he is no owner.
		expect(await approval([ADA], "private")).toBe("unavailable");
		expect(fake.sent).toEqual([]);
	});

	test("a private conversation whose approvers are none leaves nobody but an owner", async () => {
		const { fake, approval } = setup();
		expect(await approval([], "private")).toBe("unavailable");
		expect(fake.sent).toEqual([]);
	});

	test("a private conversation's person answers it alone when they are named, and is reported as the approver", async () => {
		const { fake, approval, pressAs, approvals } = setup();
		const answer = approval([ADA, SAM], "private");
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${SAM}>`);
		expect(json(fake.sent[0])).not.toContain(`<@${ADA}>`);
		expect(await pressAs(ADA)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(OWNER)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(SAM)).toEqual([]);
		expect(await answer).toBe("approved");
		expect(approvals).toEqual([
			{ principalId: SAM, speakerId: SAM, name: SAM },
		]);
	});

	test("a private conversation's person who is an owner answers it, though not named", async () => {
		const fake = fakeChannel(true);
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const ownerSpeaker: Speaker = {
			id: OWNER,
			name: "Owner",
			tier: "owner",
			principalId: OWNER,
		};
		const approvals: ApprovedBy[] = [];
		const answer = cards
			.prompts("discord:555", promptScope(ownerSpeaker, "private"))
			?.confirm("t", "**send**", undefined, "admin", undefined, undefined, {
				approvers: [ADA],
				approvedBy: (by) => approvals.push(by),
			});
		await tick();
		const pressed = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: OWNER,
		});
		await cards.handle(pressed.interaction);
		expect(await answer).toBe("approved");
		expect(approvals).toEqual([
			{ principalId: OWNER, speakerId: OWNER, name: OWNER, owner: true },
		]);
	});

	test("a private conversation's call above the person's tier stays unavailable whoever is named", async () => {
		const { fake, approval } = setup();
		expect(await approval([ADA], "private", "owner")).toBe("unavailable");
		expect(fake.sent).toEqual([]);
	});

	test("a call that names none is the speaker's own card, as before", async () => {
		const { fake, approval, pressAs } = setup();
		const answer = approval(undefined);
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${SAM}>`);
		expect(await pressAs(ADA)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(SAM)).toEqual([]);
		expect(await answer).toBe("approved");
	});

	test("a card with no scope is the owners', named approvers or not", async () => {
		const fake = fakeChannel(true);
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const answer = cards
			.prompts("discord:555")
			?.confirm("t", "m", undefined, "admin", undefined, undefined, {
				approvers: [ADA],
			});
		await tick();
		expect(json(fake.sent[0])).toContain(`<@${OWNER}>`);
		expect(json(fake.sent[0])).not.toContain(`<@${ADA}>`);
		const pressed = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: ADA,
		});
		await cards.handle(pressed.interaction);
		expect(pressed.replies).toEqual([messages().cardOwnerOnly]);
		await cards.handle(
			press("button", `${CARD_PREFIX}${fake.cardId()}:no`, { user: OWNER })
				.interaction,
		);
		expect(await answer).toBe("declined");
	});

	test("an approval after the turn stopped waiting names the approver to the late answer", async () => {
		const { approval, pressAs, late, approvals } = setup();
		const answer = approval([ADA], "shared", "admin", true);
		await tick();
		await Bun.sleep(30);
		expect(await answer).toBe("pending");
		expect(await pressAs(STRANGER)).toEqual([
			messages().cardNamedApproversRefusal,
		]);
		expect(await pressAs(ADA)).toEqual([]);
		expect(late).toEqual([
			{
				kind: "approval",
				approved: true,
				by: ADA,
				approvedBy: { principalId: ADA, speakerId: ADA, name: ADA },
				prompt: expect.any(String),
			},
		]);
		// The turn that asked had moved on; nothing is reported to it.
		expect(approvals).toEqual([]);
	});

	test("when who approved cannot be read, the call is approved without an approver", async () => {
		let reads = 0;
		const { approval, pressAs, approvals } = setup({
			...identity,
			resolve: async (facts) => {
				// The first read admits the press; the second names the approver.
				if (++reads > 1) throw new Error("identity down");
				return identity.resolve(facts);
			},
		});
		const answer = approval([ADA]);
		await tick();
		expect(await pressAs(ADA)).toEqual([]);
		expect(await answer).toBe("approved");
		expect(approvals).toEqual([]);
	});
});
