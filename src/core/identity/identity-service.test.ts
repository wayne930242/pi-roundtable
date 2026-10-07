import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { ConfigError, IdentityError } from "../domain/errors.ts";
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
import { PgPrincipalStore, SYSTEM_PRINCIPAL } from "./principal-store.ts";

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
	members: { roles: ["web:role:App.User"], everyone: ["discord"] },
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

const webFacts = (sub: string, roles: string[] = []) =>
	({
		provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20",
		subject: sub,
		name: `Web ${sub}`,
		surface: "web",
		roles,
		legacyId: `oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:${sub}`,
	}) satisfies ActorFacts;

let db: ScratchDatabase;
let store: PgPrincipalStore;
let clock: number;

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

describeDb("the identity service", () => {
	beforeAll(async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, [
			{ name: "identity", migrations: identityMigrations([]) },
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

	test("the configured owner is made, linked, and granted owner at boot; their identity resolves to them", async () => {
		const identity = await service();
		expect(await identity.principal(ADA)).toEqual({
			id: ADA,
			displayName: "Ada",
			pronouns: "she",
			disabled: false,
		});
		expect(await store.identity("discord", ADA)).toMatchObject({
			principalId: ADA,
			source: "config",
		});
		expect(await identity.resolve(discordFacts(ADA, "Ada R."))).toEqual({
			id: ADA,
			name: "Ada R.",
			tier: "owner",
			principalId: ADA,
		});
		expect((await identity.owners()).map((owner) => owner.id)).toEqual([ADA]);
	});

	test("a 0.8 speaker claims the principal of their old id at first contact, by a legacy link", async () => {
		await store.create({ id: KAI, displayName: KAI });
		const identity = await service();
		expect(await identity.resolve(discordFacts(KAI, "Kai"))).toEqual({
			id: KAI,
			name: "Kai",
			tier: "member",
			principalId: KAI,
		});
		expect(await store.identity("discord", KAI)).toMatchObject({
			principalId: KAI,
			source: "legacy",
		});
		// The M1 web chat's people claim theirs the same way.
		const web = webFacts("user-7", ["web:role:App.User"]);
		await store.create({ id: web.legacyId, displayName: "W" });
		expect((await identity.resolve(web))?.principalId).toBe(web.legacyId);
	});

	test("no claim when the principal already has an identity of that provider, nor of a new or the system id", async () => {
		await store.create({ id: KAI, displayName: KAI });
		await store.link(
			KAI,
			{ provider: "discord", subject: "966666600000000009" },
			"cli",
		);
		const identity = await service();
		const speaker = await identity.resolve(discordFacts(KAI, "Kai"));
		// Not Kai's principal: a new one, admitted as a member on Discord.
		expect(speaker?.principalId).toMatch(/^p_/);
		expect((await store.identity("discord", KAI))?.source).toBe("jit");

		const made = await store.create({ displayName: "New" });
		expect(
			(
				await identity.resolve({
					...discordFacts("966666600000000021", "X"),
					legacyId: made.id,
				})
			)?.principalId,
		).not.toBe(made.id);
		expect(
			(
				await identity.resolve({
					...discordFacts("966666600000000022", "Y"),
					legacyId: SYSTEM_PRINCIPAL,
				})
			)?.principalId,
		).not.toBe(SYSTEM_PRINCIPAL);
	});

	test("admission makes a p_ principal for someone the rules admit, and nothing for someone they do not", async () => {
		const identity = await service();
		const member = await identity.resolve(
			webFacts("user-8", ["web:role:App.User"]),
		);
		expect(member).toMatchObject({ tier: "member", name: "Web user-8" });
		expect(member?.principalId).toMatch(/^p_/);
		expect(
			(await store.identity("oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20", "user-8"))
				?.source,
		).toBe("jit");
		// The same person again resolves to the same principal.
		expect(
			(await identity.resolve(webFacts("user-8", ["web:role:App.User"])))
				?.principalId,
		).toBe(member?.principalId);
		const before = (await store.list()).length;
		expect(await identity.resolve(webFacts("user-9"))).toBeUndefined();
		expect((await store.list()).length).toBe(before);
	});

	test('provisioning "linked" serves only identities already linked', async () => {
		const identity = await service({ provisioning: "linked" });
		expect(
			await identity.resolve(webFacts("user-8", ["web:role:App.User"])),
		).toBeUndefined();
		expect((await store.list()).map((row) => row.id)).toEqual([ADA]);
		// Linked through the service, as a plugin of this process would: seen at once.
		const linked = await identity.principals.create({ displayName: "Linked" });
		await identity.principals.link(
			linked.id,
			{ provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20", subject: "user-8" },
			"cli",
		);
		expect(
			(await identity.resolve(webFacts("user-8", ["web:role:App.User"])))
				?.principalId,
		).toBe(linked.id);
	});

	test("several owners: each is made and linked, the first stays first, and an owner without a principal id gets a p_ one that later boots find again", async () => {
		const owners: AccessRules["owners"] = [
			...RULES.owners,
			{
				name: "Bo",
				identities: ["discord:966666600000000031", "token:remote-mcp"],
			},
		];
		const identity = await service({ owners });
		const bo = await identity.resolve(discordFacts("966666600000000031", "Bo"));
		expect(bo).toMatchObject({ tier: "owner" });
		expect(bo?.principalId).toMatch(/^p_/);
		expect((await identity.owners()).map((owner) => owner.displayName)).toEqual(
			["Ada", "Bo"],
		);
		const again = await service({ owners });
		expect((await again.owners()).map((owner) => owner.id)).toEqual([
			ADA,
			bo?.principalId ?? "",
		]);
		expect((await store.list()).length).toBe(2);
	});

	test("the owner tier never comes from a role the facts carry, and never by admission", async () => {
		const identity = await service({
			members: { everyone: true },
		});
		const speaker = await identity.resolve(
			discordFacts("966666600000000041", "Eve", [
				"owner",
				"discord:role:owner",
			]),
		);
		expect(speaker?.tier).toBe("member");
	});

	test("the tier is the higher of the lasting roles and the rules on this contact", async () => {
		const identity = await service();
		const kai = await store.create({ id: KAI, displayName: "Kai" });
		await store.grant(kai.id, "member", "cli");
		expect(
			(
				await identity.resolve(
					discordFacts(KAI, "Kai", ["discord:role:966666600000000077"]),
				)
			)?.tier,
		).toBe("admin");
		expect(await identity.tierOf(KAI)).toBe("member");
		const admin = await store.create({ displayName: "Admin" });
		await store.grant(admin.id, "admin", "cli");
		expect(
			await identity.tierOf(admin.id, {
				facts: discordFacts("966666600000000042", "Admin"),
			}),
		).toBe("admin");
	});

	test("a disabled principal resolves to no one, has no tier, and no turn can be started for them", async () => {
		const identity = await service();
		await store.create({ id: KAI, displayName: "Kai" });
		await store.grant(KAI, "member", "cli");
		await store.disable(KAI);
		expect(await identity.resolve(discordFacts(KAI, "Kai"))).toBeUndefined();
		expect(await identity.tierOf(KAI)).toBeUndefined();
		expect(identity.speakerFor(KAI)).rejects.toThrow(IdentityError);
	});

	test("an owner removed from the configuration loses the configured role and links, a CLI grant stays", async () => {
		const bo = { name: "Bo", principal: KAI, identities: [`discord:${KAI}`] };
		await service({ owners: [...RULES.owners, bo] });
		await store.grant(KAI, "admin", "cli");
		const identity = await service();
		expect((await store.rolesOf(KAI)).map((grant) => grant.role)).toEqual([
			"admin",
		]);
		expect(await store.identity("discord", KAI)).toBeUndefined();
		expect((await identity.owners()).map((owner) => owner.id)).toEqual([ADA]);
		// An owner granted by the CLI keeps the role across boots.
		await store.grant(KAI, "owner", "cli");
		const later = await service();
		expect((await later.owners()).map((owner) => owner.id)).toEqual([ADA, KAI]);
	});

	test("a configured owner's identity linked to another principal stops the boot", async () => {
		const other = await store.create({ displayName: "Other" });
		await store.link(other.id, { provider: "discord", subject: ADA }, "cli");
		expect(service()).rejects.toThrow(ConfigError);
	});

	test("speakerFor speaks for a principal at their lasting tier, or lower when asked; the system principal only at the tier given", async () => {
		const identity = await service();
		expect(await identity.speakerFor(ADA)).toEqual({
			id: ADA,
			name: "Ada",
			tier: "owner",
			principalId: ADA,
		});
		expect((await identity.speakerFor(ADA, "member")).tier).toBe("member");
		expect(await identity.speakerFor(SYSTEM_PRINCIPAL, "owner")).toEqual({
			id: SYSTEM_PRINCIPAL,
			name: SYSTEM_PRINCIPAL,
			tier: "owner",
			principalId: SYSTEM_PRINCIPAL,
		});
		expect(identity.speakerFor(SYSTEM_PRINCIPAL)).rejects.toThrow(
			IdentityError,
		);
		expect(identity.speakerFor("nobody")).rejects.toThrow(IdentityError);
	});

	test("someone whose tier came only from the rules is spoken for at the tier last seen, until backgroundStaleDays pass", async () => {
		const identity = await service();
		const member = await identity.resolve(
			webFacts("user-8", ["web:role:App.User"]),
		);
		const id = member?.principalId ?? "";
		// A higher tier asked for is capped at the last one seen.
		expect((await identity.speakerFor(id, "owner")).tier).toBe("member");
		clock += 31 * 24 * 60 * 60 * 1000;
		expect(identity.speakerFor(id)).rejects.toThrow(/backgroundStaleDays/);
	});

	test("being seen is recorded at most every five minutes, or when the tier changes", async () => {
		const identity = await service();
		await store.create({ id: KAI, displayName: "Kai" });
		await identity.resolve(discordFacts(KAI, "Kai"));
		const first = (await store.get(KAI))?.lastSeenAt;
		expect(first).toBeInstanceOf(Date);
		clock += 60_000;
		await identity.resolve(discordFacts(KAI, "Kai"));
		expect((await store.get(KAI))?.lastSeenAt).toEqual(first);
		await identity.resolve(
			discordFacts(KAI, "Kai", ["discord:role:966666600000000077"]),
		);
		expect((await store.get(KAI))?.lastTier).toBe("admin");
		clock += 6 * 60_000;
		await store.touch(KAI, "member");
		await identity.resolve(
			discordFacts(KAI, "Kai", ["discord:role:966666600000000077"]),
		);
		expect((await store.get(KAI))?.lastTier).toBe("admin");
	});

	test("a change another process makes, such as the CLI disabling someone, is seen within the cache's lifetime", async () => {
		const identity = await service();
		await store.create({ id: KAI, displayName: "Kai" });
		expect(await identity.resolve(discordFacts(KAI, "Kai"))).toBeDefined();
		const cli = await PgPrincipalStore.attach(db.sql);
		await cli.disable(KAI);
		clock += 31_000;
		expect(await identity.resolve(discordFacts(KAI, "Kai"))).toBeUndefined();
	});
});
