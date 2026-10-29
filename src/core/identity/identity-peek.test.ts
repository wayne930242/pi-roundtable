import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { silentLogger } from "../log.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import { type AccessRules, checkAccessRules } from "./access-policy.ts";
import type { ActorFacts } from "./actor-facts.ts";
import { identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { identityView } from "./identity-view.ts";
import { PgPrincipalStore } from "./principal-store.ts";

const ADA = "966666600000000001";
const KAI = "966666600000000003";
const ISSUER = "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20";

const RULES: AccessRules = {
	owners: [
		{
			name: "Ada",
			principal: ADA,
			identities: [`discord:${ADA}`],
		},
	],
	admins: { roles: ["web:role:App.Admin"] },
	members: { roles: ["web:role:App.User"], everyone: ["app"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

/** What the web app reports on an app sign-in: the surface is `app`, and the roles are partial. */
const appFacts = (
	sub: string,
	roles: string[] | undefined = [],
	partial = true,
): ActorFacts => ({
	provider: ISSUER,
	subject: sub,
	name: `App ${sub}`,
	surface: "app",
	...(roles === undefined ? {} : { roles }),
	...(partial ? { partial: true as const } : {}),
	legacyId: `${ISSUER}:${sub}`,
});

let db: ScratchDatabase;
let store: PgPrincipalStore;
let clock: number;

async function service(
	rules: Partial<AccessRules> = {},
): Promise<PgIdentityService> {
	const made = new PgIdentityService(
		store,
		{ ...RULES, ...rules },
		{ logger: silentLogger(), now: () => clock },
	);
	await made.syncConfig();
	return made;
}

/** A principal linked to the OIDC identity `sub`, holding `role` for good when given. */
async function linked(sub: string, role?: "admin" | "member"): Promise<string> {
	const principal = await store.create({ displayName: `Kai ${sub}` });
	await store.link(principal.id, { provider: ISSUER, subject: sub }, "cli");
	if (role) await store.grant(principal.id, role, "cli");
	return principal.id;
}

describeDb("IdentityService.peek and partial facts", () => {
	beforeAll(async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, [
			{ name: "identity", migrations: identityMigrations({ owners: [] }) },
		]);
		store = await PgPrincipalStore.attach(db.sql);
	});
	beforeEach(async () => {
		clock = Date.parse("2026-10-07T12:00:00Z");
		await db.sql`TRUNCATE principal_roles, principal_identities, principals CASCADE`;
	});
	afterAll(async () => {
		await db.drop();
	});

	test("a lasting admin grant gives the admin tier through app facts that carry no roles", async () => {
		const identity = await service();
		const id = await linked(KAI, "admin");
		expect(await identity.peek(appFacts(KAI))).toEqual({
			id: `${ISSUER}:${KAI}`,
			name: `App ${KAI}`,
			tier: "admin",
			principalId: id,
		});
	});

	test("an admin that only a rule on another surface's role gives is a member in the app, as resolve says", async () => {
		const identity = await service();
		await linked(KAI);
		// The rules name `web:role:App.Admin`; the app reports `app:role:` roles, which no rule names.
		const facts = appFacts(KAI, ["app:role:App.Admin"]);
		expect((await identity.peek(facts))?.tier).toBe("member");
		expect((await identity.resolve(facts))?.tier).toBe("member");
		const web = { ...facts, surface: "web", roles: ["web:role:App.Admin"] };
		expect((await identity.peek(web))?.tier).toBe("admin");
		expect((await identity.resolve(web))?.tier).toBe("admin");
	});

	test("peek never records anything, also on a refusal, and never reads the recorded tier", async () => {
		const identity = await service({
			members: { roles: ["web:role:App.User"] },
		});
		const id = await linked(KAI);
		await store.touch(id, "admin", new Date(clock - 60_000));
		const before = await store.get(id);
		clock += 10 * 60_000;
		// Refused: the rules give these facts no tier, and the principal was last seen as an admin.
		expect(await identity.peek(appFacts(KAI, []))).toBeUndefined();
		expect(
			await identity.peek({ ...appFacts(KAI, []), partial: undefined }),
		).toBeUndefined();
		// Admitted at member: peek says member, not the recorded admin.
		expect(
			await identity.peek(appFacts(KAI, ["app:role:x"], false)),
		).toBeUndefined();
		const web = {
			...appFacts(KAI, ["web:role:App.User"], false),
			surface: "web",
		};
		expect((await identity.peek(web))?.tier).toBe("member");
		expect(await store.get(id)).toEqual(before);
		// Resolve is the one that records, so a refusal with roles is stored.
		expect(await identity.resolve({ ...web, roles: [] })).toBeUndefined();
		expect((await store.get(id))?.lastTier).toBeUndefined();
	});

	test("an unlinked identity peeks to no one and makes no principal", async () => {
		const identity = await service();
		const count = async () => (await store.list()).length;
		const before = await count();
		expect(await identity.peek(appFacts("stranger"))).toBeUndefined();
		expect(
			await identity.peek({ ...appFacts("stranger"), legacyId: undefined }),
		).toBeUndefined();
		expect(await count()).toBe(before);
		expect(await store.identity(ISSUER, "stranger")).toBeUndefined();
		// Resolve admits the same person (the rules give them a member tier), so peek's silence is peek's own.
		expect((await identity.resolve(appFacts("stranger")))?.tier).toBe("member");
		expect((await identity.peek(appFacts("stranger")))?.tier).toBe("member");
	});

	test("a disabled principal peeks to no one", async () => {
		const identity = await service();
		const id = await linked(KAI, "member");
		await store.disable(id);
		expect(await identity.peek(appFacts(KAI))).toBeUndefined();
	});

	test("the view carries peek, frozen", async () => {
		const core = await service();
		await linked(KAI, "member");
		const speaker = await identityView(core).peek(appFacts(KAI));
		expect(speaker?.tier).toBe("member");
		expect(Object.isFrozen(speaker)).toBe(true);
	});

	test("resolve with partial facts at a lower tier leaves the recorded tier; without partial it behaves as before", async () => {
		const identity = await service();
		const id = await linked(KAI, "member");
		await store.touch(id, "admin", new Date(clock));
		for (const step of [1, 2, 3]) {
			clock += step * 6 * 60_000;
			expect((await identity.resolve(appFacts(KAI)))?.tier).toBe("member");
			expect((await store.get(id))?.lastTier).toBe("admin");
		}
		// The same facts without `partial` carry roles, so the surface is the authority: it lowers.
		clock += 6 * 60_000;
		expect((await identity.resolve(appFacts(KAI, [], false)))?.tier).toBe(
			"member",
		);
		expect((await store.get(id))?.lastTier).toBe("member");
	});

	test("a partial contact the rules refuse is not recorded as a refusal", async () => {
		const identity = await service({
			members: { roles: ["web:role:App.User"] },
		});
		const id = await linked(KAI);
		await store.touch(id, "member", new Date(clock));
		const seen = await store.get(id);
		clock += 10 * 60_000;
		expect(await identity.resolve(appFacts(KAI, []))).toBeUndefined();
		expect(await store.get(id)).toEqual(seen);
		// Without partial the roles are authoritative and the refusal is recorded.
		expect(await identity.resolve(appFacts(KAI, [], false))).toBeUndefined();
		expect((await store.get(id))?.lastTier).toBeUndefined();
	});
});

test("a line identity is accepted as an owner's identity and as a selfLink provider", () => {
	const rules = checkAccessRules({
		...RULES,
		owners: [
			{
				name: "Ada",
				principal: ADA,
				identities: [`discord:${ADA}`, "line:U0123456789abcdef"],
			},
		],
		selfLink: { providers: ["line", "discord"] },
	});
	expect(rules.owners[0]?.identities).toContain("line:U0123456789abcdef");
	expect(rules.selfLink?.providers).toEqual(["line", "discord"]);
});
