import { describe, expect, test } from "bun:test";
import { THE_SPEAKER } from "../speakers.ts";
import { OWNER_SPEAKER, TEST_OWNER } from "../testing/owner.ts";
import {
	conversationChanged,
	refusedSpeaker,
	sessionAddressee,
	sessionConversation,
	turnAddressee,
} from "./session-conversation.ts";

const OWNER = { ...TEST_OWNER, id: OWNER_SPEAKER.principalId };
const ANN = { id: "p_ann", displayName: "Ann", disabled: false };
const BO = {
	id: "p_bo",
	displayName: "Bo",
	pronouns: "he",
	disabled: false,
} as const;

describe("whom a session's conversation serves", () => {
	test("an agent's is shared; another's is as the turn names it, else as recorded, else shared", async () => {
		const recorded = {
			conversationOf: async () =>
				({ visibility: "private", principalId: "p_ann" }) as const,
			principalOf: async (id: string) => (id === ANN.id ? ANN : undefined),
		};
		expect(
			await sessionConversation(
				"fake:a",
				{
					agent: { name: "scout", session: "fake:a", home: "fake:a" },
				},
				recorded,
			),
		).toEqual({ visibility: "shared" });
		expect(
			await sessionConversation(
				"fake:a",
				{ conversation: { visibility: "shared" } },
				recorded,
			),
		).toEqual({ visibility: "shared" });
		expect(await sessionConversation("fake:a", undefined, recorded)).toEqual({
			visibility: "private",
			principalId: "p_ann",
			principal: ANN,
		});
		expect(await sessionConversation("fake:a", undefined, {})).toEqual({
			visibility: "shared",
		});
	});

	test("a turn naming another visibility or person than the session's changes it; one naming none does not", () => {
		const mine = { visibility: "private", principalId: "p_ann" } as const;
		expect(conversationChanged(mine, undefined)).toBe(false);
		expect(conversationChanged(mine, { ...mine })).toBe(false);
		expect(conversationChanged(mine, { visibility: "shared" })).toBe(true);
		expect(
			conversationChanged(mine, { visibility: "private", principalId: "p_bo" }),
		).toBe(true);
	});
});

describe("whom a session's descriptions and a turn's answers name", () => {
	test("the primary owner as configured, another person by name and pronouns, else the speaker", () => {
		const of = (principalId: string, principal?: typeof ANN) =>
			sessionAddressee(
				{
					visibility: "private",
					principalId,
					...(principal ? { principal } : {}),
				},
				OWNER,
			);
		expect(of(OWNER.id)).toBe(OWNER);
		expect(of(BO.id, BO)).toEqual({
			name: "Bo",
			pronouns: { subject: "he", object: "him", possessive: "his" },
		});
		expect(of(ANN.id, ANN).pronouns).toEqual({
			subject: "Ann",
			object: "Ann",
			possessive: "Ann's",
		});
		// A principal 0.8 left, named by their id alone, and one the host knows nothing of.
		expect(
			of("966666600000000003", {
				...ANN,
				id: "966666600000000003",
				displayName: "966666600000000003",
			}),
		).toBe(THE_SPEAKER);
		expect(of("p_kai")).toBe(THE_SPEAKER);
		expect(sessionAddressee({ visibility: "shared" }, OWNER)).toBe(THE_SPEAKER);
	});

	test("a turn's answers name a private conversation's person as its session does, and a second owner by name", () => {
		const bo = {
			id: "bo",
			name: "Bo",
			tier: "owner",
			principalId: BO.id,
		} as const;
		const private_ = {
			conversation: { visibility: "private", principalId: BO.id } as const,
			addressee: {
				name: "Bo",
				pronouns: { subject: "he", object: "him", possessive: "his" },
			},
		};
		expect(turnAddressee(bo, private_, OWNER)).toBe(private_.addressee);
		const shared = {
			conversation: { visibility: "shared" } as const,
			addressee: THE_SPEAKER,
		};
		expect(turnAddressee(bo, shared, OWNER).name).toBe("Bo");
		expect(turnAddressee(OWNER_SPEAKER, shared, OWNER)).toBe(OWNER);
		expect(
			turnAddressee(
				{ ...bo, principalId: "system", name: "Assistant" },
				shared,
				OWNER,
			),
		).toBe(OWNER);
	});
});

test("only a private conversation's person, or the host, speaks in it", () => {
	const mine = { visibility: "private", principalId: "p_ann" } as const;
	const speaker = { id: "x", name: "X", tier: "owner" } as const;
	expect(
		refusedSpeaker(mine, { ...speaker, principalId: "p_ann" }),
	).toBeUndefined();
	expect(
		refusedSpeaker(mine, { ...speaker, principalId: "system" }),
	).toBeUndefined();
	expect(refusedSpeaker(mine, { ...speaker, principalId: "p_bo" })).toContain(
		"private to p_ann",
	);
	expect(
		refusedSpeaker(
			{ visibility: "shared" },
			{ ...speaker, principalId: "p_bo" },
		),
	).toBeUndefined();
});
