import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { ConfigError, IdentityError } from "../domain/errors.ts";
import { silentLogger } from "../log.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import type { AccessRules } from "./access-policy.ts";
import type { ActorFacts } from "./actor-facts.ts";
import { identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { identityView } from "./identity-view.ts";
import {
	type DeclaredIdentity,
	declaredIdentities,
} from "./plugin-identities.ts";
import { PgPrincipalStore } from "./principal-store.ts";

const ADA = "966666600000000001";
const BO = "966666600000000002";
const KAI = "966666600000000003";
const TOKEN = "token:remote-mcp";

const RULES: AccessRules = {
	owners: [
		{
			name: "Ada",
			pronouns: "she",
			principal: ADA,
			identities: [`discord:${ADA}`],
		},
	],
	members: { everyone: ["discord", "token"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

const plugin = (
	name: string,
	identities: RoundtablePlugin["identities"],
): RoundtablePlugin => ({ name, identities, setup: () => ({}) });

const discordFacts = (id: string, name: string) =>
	({
		provider: "discord",
		subject: id,
		name,
		roles: [],
		legacyId: id,
	}) satisfies ActorFacts;

const tokenFacts = {
	provider: "token",
	subject: "remote-mcp",
	name: "Remote agent",
} satisfies ActorFacts;

let db: ScratchDatabase;
let store: PgPrincipalStore;

/** A principal as the backfill makes one of a 0.8 speaker id: claimable once by that id. */
async function carriedOver(id: string, name = id): Promise<void> {
	await db.sql`INSERT INTO principals (id, display_name, claimable) VALUES (${id}, ${name}, true)`;
}

/** A host starting with these plugin identities, its configuration synced. */
async function boot(
	identities: readonly DeclaredIdentity[],
	rules: Partial<AccessRules> = {},
): Promise<PgIdentityService> {
	const made = new PgIdentityService(
		store,
		{ ...RULES, ...rules },
		{ logger: silentLogger(), identities },
	);
	await made.syncConfig();
	return made;
}

const remote = (principal?: string): DeclaredIdentity => ({
	plugin: "remote-mcp",
	identity: TOKEN,
	...(principal === undefined ? {} : { principal }),
});

test("the identities plugins declare are read in order, each named with its plugin", () => {
	expect(
		declaredIdentities([
			plugin("notes", undefined),
			plugin("remote-mcp", [{ identity: TOKEN, principal: KAI }]),
			plugin("hooks", [{ identity: "token:hooks" }]),
		]),
	).toEqual([
		{ plugin: "remote-mcp", identity: TOKEN, principal: KAI },
		{ plugin: "hooks", identity: "token:hooks" },
	]);
});

test.each([
	[
		"an identity that does not parse",
		[plugin("remote-mcp", [{ identity: "remote-mcp" }])],
		'plugin remote-mcp: identities[0]: "remote-mcp" is not an identity written <provider>:<subject>',
	],
	[
		"a 0.8 id's alias",
		[plugin("remote-mcp", [{ identity: "legacy:remote-mcp" }])],
		"legacy:remote-mcp",
	],
	[
		"the system principal",
		[plugin("remote-mcp", [{ identity: TOKEN, principal: "system" }])],
		'the host\'s own principal "system"',
	],
	[
		"one identity two plugins declare",
		[
			plugin("remote-mcp", [{ identity: TOKEN }]),
			plugin("other", [{ identity: TOKEN, principal: KAI }]),
		],
		"plugin other: identities[0]: token:remote-mcp is declared by plugin remote-mcp too",
	],
] as const)(
	"refuses %s before anything is written",
	(_name, plugins, message) => {
		expect(() => declaredIdentities(plugins)).toThrow(ConfigError);
		expect(() => declaredIdentities(plugins)).toThrow(message);
	},
);

describeDb("identities plugins declare, linked at boot", () => {
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

	test("without a principal it is the primary owner's, linked as the plugin's, and the view reads it", async () => {
		const identity = await boot([remote()]);
		expect(await store.identity("token", "remote-mcp")).toMatchObject({
			principalId: ADA,
			source: "plugin",
		});
		const view = identityView(identity);
		expect(await view.principalOf(TOKEN)).toBe(ADA);
		expect(await view.principalOf("token:nobody")).toBeUndefined();
		expect(view.principalOf("nobody")).rejects.toThrow(IdentityError);
		expect(Object.isFrozen(view)).toBe(true);
	});

	test("bound to a member carried over from 0.8, it leaves their claim: their Discord identity still claims them", async () => {
		await carriedOver(KAI, "Kai");
		const identity = await boot([remote(KAI)]);
		expect(await store.identity("token", "remote-mcp")).toMatchObject({
			principalId: KAI,
			source: "plugin",
		});
		expect((await store.get(KAI))?.claimable).toBe(true);
		const kai = await identity.resolve(discordFacts(KAI, "Kai"));
		expect(kai).toMatchObject({ principalId: KAI, tier: "member" });
		expect(await store.identity("discord", KAI)).toMatchObject({
			principalId: KAI,
			source: "legacy",
		});
	});

	test("an unknown principal stops the boot, saying how to make or find one", async () => {
		const failed = boot([remote(KAI)]);
		expect(failed).rejects.toThrow(ConfigError);
		expect(failed).rejects.toThrow(
			`plugin remote-mcp: ${TOKEN} is bound to principal ${KAI}, and there is no principal ${KAI}`,
		);
		expect(await store.identity("token", "remote-mcp")).toBeUndefined();
	});

	test("without an owner to default to, a binding without a principal stops the boot", async () => {
		expect(boot([remote()], { owners: [] })).rejects.toThrow(
			"plugin remote-mcp: token:remote-mcp names no principal, and access.owners lists no primary owner to bind it to",
		);
	});

	test("an identity linked to someone else by the CLI or a first contact stops the boot, naming the unlink", async () => {
		await carriedOver(KAI, "Kai");
		await boot([]);
		await store.link(KAI, { provider: "token", subject: "remote-mcp" }, "cli");
		const failed = boot([remote()]);
		expect(failed).rejects.toThrow(ConfigError);
		expect(failed).rejects.toThrow(
			`plugin remote-mcp: ${TOKEN} is linked to principal ${KAI}, not to ${ADA} the plugin binds it to. Unlink it with roundtable principal unlink ${TOKEN}, or bind the plugin to ${KAI}.`,
		);
		expect(await store.identity("token", "remote-mcp")).toMatchObject({
			principalId: KAI,
			source: "cli",
		});
	});

	test("an identity the configuration lists under another owner stops the boot, naming the configuration", async () => {
		const bo = { name: "Bo", principal: BO, identities: [TOKEN] };
		const failed = boot([remote()], { owners: [...RULES.owners, bo] });
		expect(failed).rejects.toThrow(
			`plugin remote-mcp: ${TOKEN} is linked to principal ${BO}, not to ${ADA} the plugin binds it to. access.owners lists it under that owner: remove it there, or bind the plugin to ${BO}.`,
		);
	});

	test("an identity the configuration lists under the same owner stays the configuration's", async () => {
		const ada = {
			...RULES.owners[0],
			name: "Ada",
			identities: [`discord:${ADA}`, TOKEN],
		};
		await boot([remote()], { owners: [ada] });
		expect(await store.identity("token", "remote-mcp")).toMatchObject({
			principalId: ADA,
			source: "config",
		});
	});

	test("rebound at the next boot it moves, and no longer declared it is unlinked", async () => {
		await carriedOver(KAI, "Kai");
		await boot([remote(KAI)]);
		await boot([remote()]);
		expect(await store.identity("token", "remote-mcp")).toMatchObject({
			principalId: ADA,
			source: "plugin",
		});
		expect((await store.get(KAI))?.claimable).toBe(true);
		await boot([]);
		expect(await store.identity("token", "remote-mcp")).toBeUndefined();
		// The owner's own identity is the configuration's, untouched.
		expect(await store.identity("discord", ADA)).toMatchObject({
			source: "config",
		});
	});

	test("a link the CLI made to the same principal becomes the plugin's, so dropping the binding unlinks it", async () => {
		await boot([]);
		await store.link(ADA, { provider: "token", subject: "remote-mcp" }, "cli");
		await boot([remote()]);
		expect(await store.identity("token", "remote-mcp")).toMatchObject({
			source: "plugin",
		});
		await boot([]);
		expect(await store.identity("token", "remote-mcp")).toBeUndefined();
	});

	test("a declared identity is never admitted or claimed as someone new, even while unlinked", async () => {
		await carriedOver("remote-mcp", "Remote agent");
		const identity = await boot([remote()]);
		// Unlinked meanwhile, such as by another process: no one until a boot links it again.
		await store.unlink("token", "remote-mcp");
		const facts = { ...tokenFacts, legacyId: "remote-mcp" };
		expect(await identity.assess(facts)).toBeUndefined();
		expect(await identity.resolve(facts)).toBeUndefined();
		expect(await store.identity("token", "remote-mcp")).toBeUndefined();
		expect(
			(await db.sql`SELECT id FROM principals WHERE id LIKE 'p_%'`).length,
		).toBe(0);
		// Linked by the next boot, it is the bound principal's, at their tier.
		const next = await boot([remote()]);
		expect(await next.resolve(facts)).toMatchObject({
			principalId: ADA,
			tier: "owner",
		});
	});
});
