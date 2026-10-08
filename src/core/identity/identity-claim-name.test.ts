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
	members: { everyone: ["discord"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

const discordFacts = (id: string, name: string) =>
	({
		provider: "discord",
		subject: id,
		name,
		roles: [],
		legacyId: id,
	}) satisfies ActorFacts;

let db: ScratchDatabase;
let store: PgPrincipalStore;

/** A principal as the backfill makes one of a 0.8 speaker id: claimable once by that id. */
async function carriedOver(id: string, name = id): Promise<void> {
	await db.sql`INSERT INTO principals (id, display_name, claimable) VALUES (${id}, ${name}, true)`;
}

/** A service over the scratch database, its configuration synced. */
async function service(): Promise<PgIdentityService> {
	const made = new PgIdentityService(store, RULES, { logger: silentLogger() });
	await made.syncConfig();
	return made;
}

describeDb("the name of a claimed 0.8 principal", () => {
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

	test("a claimed principal the backfill named by its id takes the name its person's facts carry; a real name, an assessment, and a failed claim keep theirs", async () => {
		const identity = await service();
		await carriedOver(KAI);
		const contact = await identity.assess(discordFacts(KAI, "Kai"));
		expect((await identity.principal(KAI))?.displayName).toBe(KAI);
		expect((await store.get(KAI))?.displayName).toBe(KAI);
		expect((await contact?.take())?.principalId).toBe(KAI);
		// Read through the service's cache, which held the old name.
		expect((await identity.principal(KAI))?.displayName).toBe("Kai");
		expect((await store.get(KAI))?.displayName).toBe("Kai");

		// A name the backfill took from a schedule is a real one.
		const NOA = "966666600000000005";
		await carriedOver(NOA, "Noa");
		await identity.resolve(discordFacts(NOA, "Noa R."));
		expect((await store.get(NOA))?.claimable).toBe(false);
		expect((await identity.principal(NOA))?.displayName).toBe("Noa");

		// A claim spent by an earlier link renames no one, even with the identity unlinked again.
		const MO = "966666600000000023";
		await carriedOver(MO);
		const ref = { provider: "discord", subject: MO };
		await store.link(MO, ref, "cli");
		await store.unlink("discord", MO);
		expect(await store.claim(MO, ref, "Mo")).toBeUndefined();
		expect(
			(await identity.resolve(discordFacts(MO, "Mo")))?.principalId,
		).toMatch(/^p_/);
		expect((await store.get(MO))?.displayName).toBe(MO);
		// Nor does one whose identity is already linked, the claim another process won.
		const LEE = "966666600000000025";
		await carriedOver(LEE);
		const lee = { provider: "discord", subject: LEE };
		await store.claim(LEE, lee);
		expect(await store.claim(LEE, lee, "Lee")).toMatchObject({
			principalId: LEE,
			source: "legacy",
		});
		expect((await store.get(LEE))?.displayName).toBe(LEE);
	});
});
