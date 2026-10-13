import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { silentLogger } from "../log.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import type { AccessRules } from "./access-policy.ts";
import type { ActorFacts } from "./actor-facts.ts";
import { identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { PgPrincipalStore } from "./principal-store.ts";

const ADA = "966666600000000001";
const KAI = "966666600000000003";

const RULES: AccessRules = {
	owners: [
		{
			name: "Ada",
			pronouns: "she",
			principal: ADA,
			identities: [`discord:${ADA}`],
		},
	],
	members: { everyone: ["web", "discord"] },
	provisioning: { web: "admitted", discord: "linked" },
	backgroundStaleDays: 30,
};

const discordFacts = (id: string, name: string) =>
	({
		provider: "discord",
		subject: id,
		name,
		legacyId: id,
	}) satisfies ActorFacts;

const webFacts = (sub: string) =>
	({
		provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20",
		subject: sub,
		name: `Web ${sub}`,
		surface: "web",
	}) satisfies ActorFacts;

let db: ScratchDatabase;
let store: PgPrincipalStore;

async function service(
	rules: Partial<AccessRules> = {},
): Promise<PgIdentityService> {
	const made = new PgIdentityService(
		store,
		{ ...RULES, ...rules },
		{ logger: silentLogger(), now: () => Date.parse("2026-10-07T12:00:00Z") },
	);
	await made.syncConfig();
	return made;
}

describeDb("per-surface provisioning", () => {
	beforeAll(async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, [
			{ name: "identity", migrations: identityMigrations({ owners: [] }) },
		]);
		store = await PgPrincipalStore.attach(db.sql);
	});
	beforeEach(async () => {
		await db.sql`TRUNCATE principal_roles, principal_identities, principals`;
	});
	afterAll(async () => {
		await db.drop();
	});

	test("a linked discord id is served at member; an unlinked one is refused and not recorded", async () => {
		const identity = await service();
		expect(await identity.assess(discordFacts(KAI, "Kai"))).toBeUndefined();
		expect(await identity.resolve(discordFacts(KAI, "Kai"))).toBeUndefined();
		expect(await store.identity("discord", KAI)).toBeUndefined();
		expect((await store.list()).map((row) => row.id)).toEqual([ADA]);
		// Linked through the service's own store, as a plugin of this process would: its cache saw the miss.
		const linked = await identity.store.create({ displayName: "Kai" });
		await identity.store.link(
			linked.id,
			{ provider: "discord", subject: KAI },
			"cli",
		);
		const speaker = await identity.resolve(discordFacts(KAI, "Kai"));
		expect(speaker?.principalId).toBe(linked.id);
		expect(speaker?.tier).toBe("member");
	});

	test("web still admits at first contact, and so does a surface the map leaves out", async () => {
		const identity = await service();
		const web = await identity.resolve(webFacts("user-9"));
		expect(web?.tier).toBe("member");
		expect(
			await store.identity(webFacts("user-9").provider, "user-9"),
		).toBeDefined();
		const other = await service({
			members: { everyone: ["slack"] },
			provisioning: { discord: "linked" },
		});
		expect(
			(await other.resolve({ provider: "slack", subject: "u1", name: "U" }))
				?.tier,
		).toBe("member");
	});

	test("the one-word form still applies to every surface", async () => {
		const identity = await service({ provisioning: "linked" });
		expect(await identity.resolve(webFacts("user-9"))).toBeUndefined();
		expect((await store.list()).map((row) => row.id)).toEqual([ADA]);
		const open = await service({ provisioning: "admitted" });
		expect((await open.resolve(discordFacts(KAI, "Kai")))?.tier).toBe("member");
	});
});
