import { describe, expect, test } from "bun:test";
import type { ActorFacts } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import {
	ACCESS_PROVIDER,
	accessIdentity,
	type FakePrincipal,
	fakeIdentity,
} from "./testing/fixtures.ts";
import { consoleVisitors } from "./visitors.ts";

const ADA: FakePrincipal = {
	id: "100000000000000001",
	name: "Ada",
	tier: "owner",
	identities: ["discord:100000000000000001", accessIdentity("ada")],
};
const BEA: FakePrincipal = {
	id: "p_01J0000000000000000000BEA0",
	name: "Bea",
	tier: "owner",
	identities: [accessIdentity("bea")],
};
const MEL: FakePrincipal = {
	id: "p_01J0000000000000000000MEL0",
	name: "Mel",
	tier: "member",
	identities: [accessIdentity("mel")],
};
const ALICE: FakePrincipal = {
	id: "p_01J0000000000000000000ALI0",
	name: "Alice",
	tier: "member",
	identities: ["discord:222"],
};
const ADMIN: FakePrincipal = {
	id: "p_01J0000000000000000000ADM0",
	name: "Ari",
	tier: "admin",
	identities: [accessIdentity("ari")],
};
const GONE: FakePrincipal = {
	id: "p_01J0000000000000000000GON0",
	name: "Gus",
	tier: "owner",
	identities: [accessIdentity("gus")],
	disabled: true,
};

const facts = (sub: string): ActorFacts => ({
	provider: ACCESS_PROVIDER,
	subject: sub,
	name: `${sub}@example.test`,
});

function setup(people: FakePrincipal[], ownerId?: string) {
	const recorder = recordingLogger();
	const identify = consoleVisitors(fakeIdentity(people), {
		logger: recorder.logger,
		...(ownerId ? { ownerId } : {}),
	});
	const who = async (actor: ActorFacts | undefined) => {
		const result = await identify(actor);
		return "visitor" in result ? result.visitor.principal.id : "refused";
	};
	const warnings = () =>
		recorder.lines
			.filter((line) => line.level === "warn")
			.map((line) => line.message);
	return { identify, who, warnings };
}

describe("consoleVisitors", () => {
	test("each owner enters as their own principal", async () => {
		const { identify } = setup([ADA, BEA, MEL]);
		expect(await identify(facts("ada"))).toEqual({
			visitor: {
				principal: { id: ADA.id, displayName: "Ada", disabled: false },
			},
		});
		expect(await identify(facts("bea"))).toEqual({
			visitor: {
				principal: { id: BEA.id, displayName: "Bea", disabled: false },
			},
		});
	});

	test("a member, an admin, and a disabled owner are refused, and the refusal names the principal", async () => {
		const { identify, who } = setup([ADA, BEA, MEL, ADMIN, GONE]);
		expect(await who(facts("mel"))).toBe("refused");
		expect(await who(facts("ari"))).toBe("refused");
		expect(await who(facts("gus"))).toBe("refused");
		expect(await identify(facts("mel"))).toEqual({
			refusal: `principal ${MEL.id} holds no owner role`,
		});
	});

	test("with two owners, an identity linked to no one is refused with what to configure", async () => {
		const { identify } = setup([ADA, BEA]);
		expect(await identify(facts("stranger"))).toEqual({
			refusal: `${accessIdentity("stranger")} is linked to no principal`,
		});
	});

	test("with one owner, a member's Access identity linked to no one is refused, and the fix is logged once", async () => {
		const { identify, who, warnings } = setup([ADA, ALICE]);
		expect(await identify(facts("alice-cf-sub"))).toEqual({
			refusal: `${accessIdentity("alice-cf-sub")} is linked to no principal`,
		});
		expect(await who(facts("alice-cf-sub"))).toBe("refused");
		const named = accessIdentity("alice-cf-sub");
		expect(warnings()).toEqual([
			`web-console: ${named} is linked to no principal, so the console refuses it. If it is an owner's, add "${named}" to that owner's access.owners[].identities, or run: roundtable principal link <owner's principal id> ${named}`,
		]);
	});

	test("with one owner, the owner's linked identity enters", async () => {
		const { who, warnings } = setup([ADA, ALICE]);
		expect(await who(facts("ada"))).toBe(ADA.id);
		expect(warnings()).toEqual([]);
	});

	test("the fix is logged for at most a bounded number of identities", async () => {
		const { who, warnings } = setup([ADA]);
		for (let i = 0; i < 150; i++)
			expect(await who(facts(`sub-${i}`))).toBe("refused");
		expect(warnings()).toHaveLength(100);
	});

	test("an identity of a principal who is no owner is never taken as the only owner", async () => {
		const { who } = setup([ADA, MEL]);
		expect(await who(facts("mel"))).toBe("refused");
	});

	test("without an actor, the request is the primary owner's, with one warning", async () => {
		const { who, warnings } = setup([BEA, ADA]);
		expect(await who(undefined)).toBe(BEA.id);
		expect(await who(undefined)).toBe(BEA.id);
		expect(warnings()).toEqual([
			"web-console: the verifier reports no actor, so the console takes every request it admits as the primary owner's. Have it report who signed in (cloudflareAccess does)",
		]);
	});

	test("without an actor, ownerId names the owner instead, who must still hold the owner role", async () => {
		expect(await setup([ADA, BEA], BEA.id).who(undefined)).toBe(BEA.id);
		expect(await setup([ADA, MEL], MEL.id).who(undefined)).toBe("refused");
		expect(await setup([ADA], "unknown").who(undefined)).toBe("refused");
	});

	test("a host with no owner admits no one", async () => {
		const { who } = setup([MEL]);
		expect(await who(undefined)).toBe("refused");
		expect(await who(facts("stranger"))).toBe("refused");
	});

	test("a legacy identity is refused before it is looked up, as IDENTITY.resolve refuses it", async () => {
		const legacy: FakePrincipal = {
			...ADA,
			identities: [...(ADA.identities ?? []), "legacy:remote-mcp"],
		};
		const { identify } = setup([legacy]);
		expect(
			await identify({
				provider: "legacy",
				subject: "remote-mcp",
				name: "remote-mcp",
			}),
		).toEqual({ refusal: "legacy:remote-mcp is a 0.8 id, not an identity" });
	});

	test("facts that are no identity are refused", async () => {
		const { identify } = setup([ADA]);
		expect(
			await identify({ provider: "", subject: "x", name: "x" }),
		).toMatchObject({ refusal: expect.stringContaining("no identity") });
	});
});
