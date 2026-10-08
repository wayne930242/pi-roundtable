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
	admins: { roles: ["discord:role:966666600000000077"] },
	members: { everyone: ["discord"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

const discordFacts = (id: string, name: string, roles: string[] = []) =>
	({
		provider: "discord",
		subject: id,
		name,
		roles,
		legacyId: id,
	}) satisfies ActorFacts;

let db: ScratchDatabase;
let store: PgPrincipalStore;
let clock: number;

/** A principal as the backfill makes one of a 0.8 speaker id: claimable once by that id. */
async function carriedOver(id: string, name = id): Promise<void> {
	await db.sql`INSERT INTO principals (id, display_name, claimable) VALUES (${id}, ${name}, true)`;
}

/** A service over the scratch database, its configuration synced, on the test's clock. */
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

describeDb(
	"the identity service's owner identities and contacts by turns",
	() => {
		beforeAll(async () => {
			db = await scratchDatabase();
			await runMigrations(db.sql, [
				{ name: "identity", migrations: identityMigrations({ owners: [] }) },
			]);
			store = await PgPrincipalStore.attach(db.sql);
		});
		beforeEach(async () => {
			clock = Date.parse("2026-10-07T12:00:00Z");
			await db.sql`TRUNCATE principal_roles, principal_identities, principals`;
		});
		afterAll(async () => {
			await db.drop();
		});

		test("an identity the configuration lists for an owner, linked to them before by another way, becomes the configuration's, so dropping it unlinks it", async () => {
			const web = `oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:ada`;
			await service();
			await store.link(
				ADA,
				{ provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20", subject: "ada" },
				"cli",
			);
			const withWeb = {
				...RULES.owners[0],
				name: "Ada",
				identities: [`discord:${ADA}`, web],
			};
			await service({ owners: [withWeb] });
			expect(
				await store.identity("oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20", "ada"),
			).toMatchObject({ principalId: ADA, source: "config" });
			await service();
			expect(
				await store.identity("oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20", "ada"),
			).toBeUndefined();
		});

		test("an identity the configuration lists for an owner is never admitted or claimed as someone else, even while unlinked", async () => {
			const bo = {
				name: "Bo",
				principal: "bo",
				identities: [`discord:${KAI}`],
			};
			const identity = await service({ owners: [...RULES.owners, bo] });
			await carriedOver(KAI, "Kai");
			// Unlinked meanwhile, such as by another process: no one until a boot links it again.
			await store.unlink("discord", KAI);
			expect(await identity.assess(discordFacts(KAI, "Kai"))).toBeUndefined();
			expect(await identity.resolve(discordFacts(KAI, "Kai"))).toBeUndefined();
			expect(await store.identity("discord", KAI)).toBeUndefined();
			expect((await store.get(KAI))?.claimable).toBe(true);
			expect(
				(await db.sql`SELECT id FROM principals WHERE id LIKE 'p_%'`).length,
			).toBe(0);
		});

		test("someone served and refused by turns, such as in two guilds, is written a few times, not at every message", async () => {
			const role = "discord:role:966666600000000088";
			let touches = 0;
			const counting = new Proxy(store, {
				get(target, key) {
					const value = Reflect.get(target, key, target);
					if (typeof value !== "function") return value;
					return key === "touch"
						? (...args: unknown[]) => {
								touches++;
								return value.apply(target, args);
							}
						: value.bind(target);
				},
			});
			const identity = new PgIdentityService(
				counting,
				{ ...RULES, admins: {}, members: { roles: [role] } },
				{ logger: silentLogger(), now: () => clock },
			);
			await identity.syncConfig();
			await carriedOver(KAI, "Kai");
			const served = discordFacts(KAI, "Kai", [role]);
			const refused = discordFacts(KAI, "Kai", []);
			expect((await identity.resolve(served))?.tier).toBe("member");
			// Refused once, then served again: the tier comes back at once.
			clock += 1_000;
			expect(await identity.resolve(refused)).toBeUndefined();
			clock += 1_000;
			expect((await identity.resolve(served))?.tier).toBe("member");
			expect((await identity.speakerFor(KAI)).tier).toBe("member");
			for (let i = 0; i < 20; i++) {
				clock += 1_000;
				expect(await identity.resolve(refused)).toBeUndefined();
				clock += 1_000;
				expect((await identity.resolve(served))?.tier).toBe("member");
			}
			expect(touches).toBeLessThanOrEqual(4);
			// Until it settles, they hold the lower of the two: no tier for their background turns.
			expect(identity.speakerFor(KAI)).rejects.toThrow(/holds no tier/);
			clock += 6 * 60_000;
			expect((await identity.resolve(served))?.tier).toBe("member");
			expect((await identity.speakerFor(KAI)).tier).toBe("member");
		});
	},
);
