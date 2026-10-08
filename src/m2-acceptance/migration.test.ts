import { afterEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { runMigrations } from "../core/db/migrations.ts";
import type { AccessRules } from "../core/identity/access-policy.ts";
import type { ActorFacts } from "../core/identity/actor-facts.ts";
import { identityPlugin } from "../core/identity/identity-plugin.ts";
import { PgIdentityService } from "../core/identity/identity-service.ts";
import { PgPrincipalStore } from "../core/identity/principal-store.ts";
import { silentLogger } from "../core/log.ts";
import type { PluginContext, RoundtablePlugin } from "../core/plugin.ts";
import { describeDb } from "../core/testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../core/testing/fixture-database.ts";

// §6.1 of the M2 plan, on the database a 0.8.0 host leaves (src/core/testing/fixtures/db-0.8.0.sql):
// the starts after the upgrade, the rows an older build writes after it, and the people of 0.8
// coming back. src/m2-acceptance/acceptance-index.test.ts lists where the rest of §6.1 is tested.

/** The people of the 0.8.0 fixture (scripts/fixture-db.ts). */
const OWNER = "966666600000000001";
const KAI = "966666600000000003";
const NOA = "966666600000000005";
const WEB_PROVIDER = "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20";
const WEB = `${WEB_PROVIDER}:user-7`;

/** The fixture host's people: its owner on Discord, Discord members, and web members by role. */
const RULES: AccessRules = {
	owners: [{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] }],
	members: { everyone: ["discord"], roles: ["web:role:App.User"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

/** The identity plugin of a host that also runs remote MCP, whose token it links at setup. */
const identity = () =>
	identityPlugin({
		rules: RULES,
		plugins: [
			{
				name: "remote-mcp",
				identities: [{ identity: "token:remote-mcp" }],
				setup: () => ({}),
			},
		],
	});

/** One start of the host's identity: its migrations, the backfill among them, then its setup. */
async function start(sql: SQL, plugin: RoundtablePlugin = identity()) {
	await runMigrations(sql, [plugin]);
	await plugin.setup?.({
		logger: silentLogger(),
		database: () => sql,
		services: { provide: () => {} },
	} as unknown as PluginContext);
}

/** Every row of the identity tables and of the tables 0.8 stores people's ids in, in a stable order. */
async function everything(sql: SQL) {
	return {
		principals: await sql`SELECT * FROM principals ORDER BY id`,
		identities:
			await sql`SELECT * FROM principal_identities ORDER BY provider, subject`,
		roles: await sql`SELECT * FROM principal_roles ORDER BY principal_id, role`,
		memory: await sql`SELECT * FROM owner_memory ORDER BY id`,
		schedules: await sql`SELECT * FROM schedules ORDER BY id`,
		conversations: await sql`SELECT * FROM conversations ORDER BY key`,
		held: await sql`SELECT * FROM held_actions ORDER BY channel_key`,
	};
}

const ids = async (sql: SQL) =>
	(await sql`SELECT id FROM principals ORDER BY id`).map(
		(row: { id: string }) => row.id,
	);

let db: ScratchDatabase | undefined;
afterEach(async () => {
	await db?.drop();
	db = undefined;
});

describeDb("upgrading a 0.8.0 database", () => {
	test("a second start writes nothing: the principals, their identities and roles, and every 0.8 row stay as the first start left them", async () => {
		db = await scratchDatabase("0.8.0");
		await start(db.sql);
		const first = await everything(db.sql);
		expect(first.principals.map((row: { id: string }) => row.id)).toEqual(
			[OWNER, KAI, NOA, WEB].sort(),
		);
		await start(db.sql);
		expect(await everything(db.sql)).toEqual(first);
	});

	test("what an older build writes after the upgrade, in each table 0.8 names people in, gets its principal at the next start, and no row is rewritten", async () => {
		db = await scratchDatabase("0.8.0");
		await start(db.sql);
		const before = await ids(db.sql);
		// As 0.8 writes them after a downgrade: its columns only, each naming someone new.
		const [memory, schedule, conversation, held] = [
			"966666600000000061",
			"966666600000000062",
			`${WEB_PROVIDER}:user-63`,
			"966666600000000064",
		];
		await db.sql`INSERT INTO owner_memory (fact, kind, speaker_id) VALUES ('Mo likes tea', 'core', ${memory})`;
		await db.sql`
			INSERT INTO schedules (id, channel_key, mode, title, prompt, recurrence, next_run, created_by_id, created_by_name, created_tier)
			SELECT nextval('schedules_id_seq'), 'discord:966666600000000065', mode, title, prompt, recurrence, next_run, ${schedule}, 'Sol', 'member'
			FROM schedules WHERE id = 2`;
		await db.sql`
			INSERT INTO conversations (key, surface, kind, principal_id, visibility, title)
			VALUES ('web:c-63', 'web', 'chat', ${conversation}, 'private', 'Notes')`;
		await db.sql`
			INSERT INTO held_actions (channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at)
			VALUES ('discord:966666600000000066', 'agent', now(), '[]', ${held}, now())`;
		const written = await everything(db.sql);
		await start(db.sql);
		expect(await ids(db.sql)).toEqual(
			[...before, memory, schedule, conversation, held].sort(),
		);
		const after = await everything(db.sql);
		for (const table of [
			"memory",
			"schedules",
			"conversations",
			"held",
		] as const)
			expect(after[table]).toEqual(written[table]);
	});

	test("the people of 0.8 come back as their principals at first contact, on Discord and on the web; an identity of a provider the principal already has claims nothing", async () => {
		db = await scratchDatabase("0.8.0");
		await start(db.sql);
		const conversationBefore =
			await db.sql`SELECT * FROM conversations WHERE key = 'web:c-1'`;
		const service = new PgIdentityService(
			await PgPrincipalStore.attach(db.sql),
			RULES,
			{ logger: silentLogger() },
		);
		const discord = (subject: string, legacyId: string): ActorFacts => ({
			provider: "discord",
			subject,
			name: `Discord ${subject}`,
			surface: "discord",
			roles: [],
			legacyId,
		});
		expect((await service.resolve(discord(KAI, KAI)))?.principalId).toBe(KAI);
		const web = await service.resolve({
			provider: WEB_PROVIDER,
			subject: "user-7",
			name: "Wen",
			surface: "web",
			roles: ["web:role:App.User"],
			legacyId: WEB,
		});
		expect(web).toMatchObject({ id: WEB, principalId: WEB, tier: "member" });
		// M1's private web conversation is still theirs, its row as 0.8 wrote it.
		expect(
			await db.sql`SELECT * FROM conversations WHERE key = 'web:c-1'`,
		).toEqual(conversationBefore);
		expect(conversationBefore[0]).toMatchObject({ principal_id: WEB });
		for (const [provider, subject, principal] of [
			["discord", KAI, KAI],
			[WEB_PROVIDER, "user-7", WEB],
		] as const)
			expect(await service.store.identity(provider, subject)).toMatchObject({
				principalId: principal,
				source: "legacy",
			});
		// Another Discord account naming Kai's 0.8 id: Kai has a Discord identity, so it is someone new.
		const other = await service.resolve(discord("966666600000000067", KAI));
		expect(other?.principalId).toMatch(/^p_/);
		// Noa, never contacted, is still claimable by their own Discord account.
		expect((await service.resolve(discord(NOA, NOA)))?.principalId).toBe(NOA);
	});
});
