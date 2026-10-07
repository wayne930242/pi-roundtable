import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SQL } from "bun";
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
import type { IdentityService } from "./identity-service.ts";

/** The people of the 0.8.0 fixture (scripts/fixture-db.ts). */
const OWNER = "966666600000000001";
const MEMBERS = ["966666600000000003", "966666600000000005"];
const WEB = "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7";

/** The plugins, with their migrations, of a single-owner Discord host of this version. */
async function hostPlugins(url: string) {
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
		// Each may be claimed once by the person of its id.
		expect(
			(await db.sql`SELECT id FROM principals WHERE claimable ORDER BY id`).map(
				(row: { id: string }) => row.id,
			),
		).toEqual(ids);
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
			await backfillPrincipals(db.sql, [{ id: OWNER, name: "Ada" }], {
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
		const owners = [{ id: OWNER, name: "Ada" }];
		const planned = await backfillPrincipals(db.sql, owners, { dryRun: true });
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
			(await backfillPrincipals(db.sql, owners, { dryRun: true })).created,
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
			[{ id: "system", name: "System" }],
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
