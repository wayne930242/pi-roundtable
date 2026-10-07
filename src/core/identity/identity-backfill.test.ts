import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SQL } from "bun";
import type { RoundtableConfig } from "../config/config.ts";
import { runMigrations } from "../db/migrations.ts";
import { defineRoundtable } from "../define-roundtable.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext } from "../plugin.ts";
import { IDENTITY } from "../services.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { identityPlugin } from "./identity-plugin.ts";
import { backfillPrincipals } from "./identity-schema.ts";
import { type IdentityService, PgIdentityService } from "./identity-service.ts";
import { PgPrincipalStore } from "./principal-store.ts";

/** The people of the 0.8.0 fixture (scripts/fixture-db.ts). */
const OWNER = "966666600000000001";
const MEMBERS = ["966666600000000003", "966666600000000005"];
const WEB = "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7";
/** The rules of the fixture's host: its owner, and no one else. */
const ADA_ONLY = {
	owners: [{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] }],
};

/** The plugins, with their migrations, of a single-owner Discord host of this version. */
async function hostPlugins(
	url: string,
	speakers?: RoundtableConfig["speakers"],
) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-backfill-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const defined = await defineRoundtable(
		{
			owner: { id: OWNER, name: "Ada" },
			...(speakers ? { speakers } : {}),
			discord: {
				token: "token",
				guild: "966666600000000002",
				entryChannel: "966666600000000004",
			},
			database: { url },
			dataDir: dir,
			model: "anthropic/claude-sonnet-5-5",
			http: { publicUrl: "https://bot.example.com", port: 8080 },
		},
		{ logger: silentLogger(), modelRuntime },
	);
	return defined.plugins;
}

/** Every row of the tables 0.8 stores people's ids in, in a stable order. */
async function personRows(sql: SQL) {
	return {
		memory: await sql`SELECT * FROM owner_memory ORDER BY id`,
		schedules: await sql`SELECT * FROM schedules ORDER BY id`,
		conversations: await sql`SELECT * FROM conversations ORDER BY key`,
		held: await sql`SELECT * FROM held_actions ORDER BY channel_key`,
	};
}

const principals = async (sql: SQL) =>
	(await sql`SELECT id, display_name FROM principals ORDER BY id`) as {
		id: string;
		display_name: string;
	}[];

let db: ScratchDatabase | undefined;
afterEach(async () => {
	await db?.drop();
	db = undefined;
});

describeDb("the principal backfill", () => {
	test("on a 0.8.0 database, every stored id becomes a principal of the same id and no row changes", async () => {
		db = await scratchDatabase("0.8.0");
		const before = await personRows(db.sql);
		const plugins = await hostPlugins(db.url);
		const first = await runMigrations(db.sql, plugins);
		expect(first.applied).toContain("identity/principals");
		expect(first.everyBoot).toContain("identity/backfill");
		const ids = (await principals(db.sql)).map((row) => row.id);
		expect(ids).toEqual([OWNER, ...MEMBERS, WEB, "remote-mcp"].sort());
		expect(await personRows(db.sql)).toEqual(before);
		// Each may be claimed once by the person of its id, except the configured owner.
		expect(
			(await db.sql`SELECT id FROM principals WHERE claimable ORDER BY id`).map(
				(row: { id: string }) => row.id,
			),
		).toEqual(ids.filter((id) => id !== OWNER));
		// The owner is named as the configuration names them; a schedule's author by the schedule.
		const names = Object.fromEntries(
			(await principals(db.sql)).map((row) => [row.id, row.display_name]),
		);
		expect(names[OWNER]).toBe("Ada");
		expect(names["remote-mcp"]).toBe("Remote");
		expect(names[MEMBERS[0] ?? ""]).toBe("Kai");

		await runMigrations(db.sql, plugins);
		expect((await principals(db.sql)).map((row) => row.id)).toEqual(ids);
	});

	test("a database an earlier build made the principals table on, without the claimable column, still boots and gets it", async () => {
		db = await scratchDatabase("0.8.0");
		// identity/principals as the build before the claimable column (927d38a) recorded it.
		await runMigrations(db.sql, [
			{
				name: "identity",
				migrations: [
					{
						name: "principals",
						up: async (sql) => {
							await sql`
								CREATE TABLE principals (
									id text PRIMARY KEY,
									display_name text NOT NULL,
									pronouns text CHECK (pronouns IN ('he', 'she', 'they')),
									locale text,
									time_zone text,
									created_at timestamptz NOT NULL DEFAULT now(),
									disabled_at timestamptz,
									last_seen_at timestamptz,
									last_tier text CHECK (last_tier IN ('member', 'admin', 'owner'))
								)`;
							await sql`INSERT INTO principals (id, display_name) VALUES (${OWNER}, 'Ada')`;
						},
					},
				],
			},
		]);
		const report = await runMigrations(db.sql, await hostPlugins(db.url));
		expect(report.skipped).toContain("identity/principals");
		expect(report.applied).toContain("identity/principals-claimable");
		const claimable = Object.fromEntries(
			(
				(await db.sql`SELECT id, claimable FROM principals`) as {
					id: string;
					claimable: boolean;
				}[]
			).map((row) => [row.id, row.claimable]),
		);
		// The row the earlier build made is not claimable; the ones this backfill makes are.
		expect(claimable[OWNER]).toBe(false);
		expect(claimable[MEMBERS[0] ?? ""]).toBe(true);
	});

	test("a configured owner is never claimable, so one with no identity linked is not claimed once someone else is the owner", async () => {
		db = await scratchDatabase("0.8.0");
		// The web template's owner, and the shape of a 0.8 owner on a host without Discord.
		const operator = {
			owners: [{ name: "Operator", principal: "operator", identities: [] }],
			members: { everyone: true },
			provisioning: "admitted" as const,
			backgroundStaleDays: 30,
		};
		await runMigrations(db.sql, [identityPlugin({ rules: operator })]);
		const sql = db.sql;
		const claimable = async () =>
			(await sql`SELECT claimable FROM principals WHERE id = 'operator'`)[0]
				?.claimable;
		expect(await claimable()).toBe(false);
		// As an earlier build left it: the next boot takes the claim back.
		await db.sql`UPDATE principals SET claimable = true WHERE id = 'operator'`;
		await runMigrations(db.sql, [identityPlugin({ rules: operator })]);
		expect(await claimable()).toBe(false);
		// Another owner later: the old one's id claims nothing for whoever reports it.
		const identity = new PgIdentityService(
			await PgPrincipalStore.attach(db.sql),
			{
				...operator,
				owners: [
					{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] },
				],
			},
			{ logger: silentLogger() },
		);
		await identity.syncConfig();
		const speaker = await identity.resolve({
			provider: "token",
			subject: "operator",
			name: "Operator",
			legacyId: "operator",
		});
		expect(speaker?.principalId).not.toBe("operator");
	});

	test("a row an older build writes after the upgrade gets its principal at the next boot", async () => {
		db = await scratchDatabase("0.8.0");
		const plugins = await hostPlugins(db.url);
		await runMigrations(db.sql, plugins);
		// As 0.8 would write it after a downgrade.
		await db.sql`INSERT INTO owner_memory (fact, kind, speaker_id) VALUES ('Mo likes tea', 'core', '966666600000000007')`;
		await runMigrations(db.sql, plugins);
		expect((await principals(db.sql)).map((row) => row.id)).toContain(
			"966666600000000007",
		);
	});

	test("a held action that names its principal is not a 0.8 speaker: its actor id makes no principal", async () => {
		db = await scratchDatabase("0.8.0");
		const plugins = await hostPlugins(db.url);
		await runMigrations(db.sql, plugins);
		// As this version stores one: the actor id beside the principal it resolved to.
		await db.sql`ALTER TABLE held_actions ADD COLUMN IF NOT EXISTS principal_id text`;
		const calls = JSON.stringify([]);
		await db.sql`
			INSERT INTO held_actions (channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at, principal_id)
			VALUES ('discord:966666600000000014', 'agent', now(), ${calls}, '966666600000000009', now(), 'p_01K0000000000000000000000A')`;
		// As 0.8 writes one after a downgrade: no principal named.
		await db.sql`
			INSERT INTO held_actions (channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at)
			VALUES ('discord:966666600000000015', 'agent', now(), ${calls}, '966666600000000008', now())`;
		await runMigrations(db.sql, plugins);
		const ids = (await principals(db.sql)).map((row) => row.id);
		expect(ids).toContain("966666600000000008");
		expect(ids).not.toContain("966666600000000009");
	});

	test("a 0.8 author of schedules is seen at upgrade at the highest tier they scheduled at, capped by what the rules could give them", async () => {
		db = await scratchDatabase("0.8.0");
		const upgraded = new Date();
		// Everyone on Discord is a member: the most the rules give anyone besides the owner.
		await runMigrations(
			db.sql,
			await hostPlugins(db.url, { members: { everyone: true } }),
		);
		const seen = Object.fromEntries(
			(
				(await db.sql`SELECT id, last_tier, last_seen_at FROM principals`) as {
					id: string;
					last_tier: string | null;
					last_seen_at: Date | null;
				}[]
			).map((row) => [row.id, row]),
		);
		const [kai, noa] = MEMBERS;
		// Kai scheduled as a member; remote-mcp as owner, capped to member.
		expect(seen[kai ?? ""]?.last_tier).toBe("member");
		expect(seen["remote-mcp"]?.last_tier).toBe("member");
		expect(seen[kai ?? ""]?.last_seen_at?.getTime()).toBeGreaterThanOrEqual(
			upgraded.getTime() - 1000,
		);
		// No schedule, or the configured owner: not seen.
		for (const id of [noa ?? "", WEB, OWNER])
			expect(seen[id]).toMatchObject({ last_tier: null, last_seen_at: null });

		// Their schedules keep running at that tier, as OD-4 allows for 30 days.
		const identity = new PgIdentityService(
			await PgPrincipalStore.attach(db.sql),
			{
				owners: [
					{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] },
				],
				members: { everyone: ["discord"] },
				provisioning: "admitted",
				backgroundStaleDays: 30,
			},
			{ logger: silentLogger() },
		);
		expect((await identity.speakerFor(kai ?? "", "owner")).tier).toBe("member");
	});

	test("rules that give no one besides the owners a tier leave a 0.8 author of schedules unseen", async () => {
		db = await scratchDatabase("0.8.0");
		await runMigrations(db.sql, await hostPlugins(db.url));
		const rows = (await db.sql`
			SELECT id FROM principals WHERE last_tier IS NOT NULL OR last_seen_at IS NOT NULL`) as {
			id: string;
		}[];
		expect(rows).toEqual([]);
	});

	test("an empty database boots, with the configured owner as the only principal", async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, await hostPlugins(db.url));
		expect(await principals(db.sql)).toEqual([
			{ id: OWNER, display_name: "Ada" },
		]);
	});

	test("a table from before it named people is skipped, not an error", async () => {
		db = await scratchDatabase();
		// held_actions and owner_memory as builds before speakers made them.
		await db.sql`CREATE TABLE held_actions (channel_key text PRIMARY KEY, calls text)`;
		await db.sql`CREATE TABLE owner_memory (id bigserial PRIMARY KEY, fact text NOT NULL)`;
		expect(
			await backfillPrincipals(db.sql, ADA_ONLY, {
				dryRun: true,
			}),
		).toEqual({
			created: 1,
			sources: {
				config: 1,
				owner_memory: 0,
				schedules: 0,
				conversations: 0,
				held_actions: 0,
			},
		});
	});

	test("the summary counts the ids of each table, and a dry run writes nothing", async () => {
		db = await scratchDatabase("0.8.0");
		const planned = await backfillPrincipals(db.sql, ADA_ONLY, {
			dryRun: true,
		});
		expect(planned).toEqual({
			created: 5,
			sources: {
				config: 1,
				owner_memory: 3,
				schedules: 3,
				conversations: 1,
				held_actions: 1,
			},
		});
		expect(
			(await db.sql`SELECT to_regclass('principals') AS t`)[0]?.t,
		).toBeNull();
		await runMigrations(db.sql, await hostPlugins(db.url));
		expect(
			(await backfillPrincipals(db.sql, ADA_ONLY, { dryRun: true })).created,
		).toBe(0);
	});
});

describeDb("the identity plugin", () => {
	test("logs the boot's backfill in one line at setup, and provides the principals as IDENTITY", async () => {
		db = await scratchDatabase("0.8.0");
		const plugin = identityPlugin({
			rules: {
				owners: [
					{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] },
				],
				provisioning: "admitted",
				backgroundStaleDays: 30,
			},
		});
		await runMigrations(db.sql, [plugin]);
		const { logger, lines } = recordingLogger();
		const provided = new Map<string, unknown>();
		const sql = db.sql;
		await plugin.setup?.({
			logger,
			database: () => sql,
			services: {
				provide: (key: { id: string }, value: unknown) =>
					provided.set(key.id, value),
			},
		} as unknown as PluginContext);
		expect(lines).toEqual([
			{
				level: "info",
				fields: {},
				message:
					"principal backfill: 5 created; ids found: config 1, owner_memory 3, schedules 3, conversations 1, held_actions 1",
			},
		]);
		const identity = provided.get(IDENTITY.id) as IdentityService;
		// Plugins read through it; the principals are written by the core and the CLI only.
		expect(Object.keys(identity).sort()).toEqual(
			[
				"identities",
				"list",
				"owners",
				"principal",
				"resolve",
				"roles",
				"speakerFor",
				"tierOf",
			].sort(),
		);
		expect(Object.isFrozen(identity)).toBe(true);
		expect("store" in identity).toBe(false);
		expect(await identity.principal(OWNER)).toMatchObject({
			id: OWNER,
			displayName: "Ada",
		});
		expect((await identity.owners()).map((owner) => owner.id)).toEqual([OWNER]);
	});
});

describeDb("the system principal", () => {
	test("is never backfilled, even where a table names it", async () => {
		db = await scratchDatabase("0.8.0");
		await db.sql`INSERT INTO owner_memory (fact, kind, speaker_id) VALUES ('A system note', 'core', 'system')`;
		await db.sql`INSERT INTO conversations (key, surface, kind, principal_id, visibility) VALUES ('web:c-9', 'web', 'chat', 'system', 'private')`;
		const summary = await backfillPrincipals(
			db.sql,
			{ owners: [{ name: "System", principal: "system", identities: [] }] },
			{ dryRun: true },
		);
		expect(summary.sources).toMatchObject({
			config: 0,
			owner_memory: 3,
			conversations: 1,
		});
		await runMigrations(db.sql, await hostPlugins(db.url));
		expect((await principals(db.sql)).map((row) => row.id)).not.toContain(
			"system",
		);
	});
});
