import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { MigrationError, PluginError } from "../errors.ts";
import { Roundtable } from "../host.ts";
import { type Logger, silentLogger } from "../log.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import {
	type Migration,
	migrate,
	migrateDatabase,
	openPool,
	runMigrations,
} from "./migrations.ts";

// The core cannot import a consumer's test helpers, so it reads the test database itself.
const url = process.env.ROUNDTABLE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

/** What the promise rejected with; undefined when it resolved. */
async function rejection(
	promise: Promise<unknown> | undefined,
): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

function recording(name: string, log: string[], fails = false): Migration {
	return {
		name,
		up: async () => {
			log.push(name);
			if (fails) throw new Error("boom");
		},
	};
}

// One host runs per process, so a test that leaves one running would block the next.
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
});

function roundtable(
	plugins: RoundtablePlugin[],
	database?: { url: string },
	logger: Logger = silentLogger(),
): { host: Roundtable } {
	const host = new Roundtable(
		{
			logger,
			drain: { intervalMs: 1, limitMs: 50 },
			...(database ? { database } : {}),
		},
		plugins,
	);
	hosts.push(host);
	return { host };
}

const table = "roundtable_migration_test";
const tableMigration: Migration = {
	name: "test-table",
	up: async (sql) => {
		await sql.unsafe(
			`CREATE TABLE IF NOT EXISTS ${table} (id int PRIMARY KEY, note text NOT NULL)`,
		);
		await sql.unsafe(
			`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS added text NOT NULL DEFAULT 'x'`,
		);
	},
};

describe("migrate", () => {
	// A pool connects on its first query, so these never reach a server.
	const unreachable = () => openPool("postgres://nobody@127.0.0.1:1/none");

	test("runs the migrations in order", async () => {
		const log: string[] = [];
		const sql = unreachable();
		await migrate(sql, [recording("a", log), recording("b", log)]);
		await sql.close();
		expect(log).toEqual(["a", "b"]);
	});

	test("refuses a name declared twice before running any", async () => {
		const log: string[] = [];
		const sql = unreachable();
		const error = await rejection(
			migrate(sql, [recording("a", log), recording("a", log)]),
		);
		await sql.close();
		expect(error).toBeInstanceOf(PluginError);
		expect(log).toEqual([]);
	});

	test("stops at a failing migration and names it", async () => {
		const log: string[] = [];
		const sql = unreachable();
		const error = await rejection(
			migrate(sql, [recording("a", log, true), recording("b", log)]),
		);
		await sql.close();
		expect(error).toBeInstanceOf(MigrationError);
		expect(String(error)).toContain("migration a failed");
		expect(log).toEqual(["a"]);
	});
});

/** A database of its own, so the ledger and the tables of the shared test database stay as they are. */
async function createDatabase(): Promise<{
	url: string;
	drop(): Promise<void>;
}> {
	const admin = new SQL(url ?? "", { max: 1 });
	const name = `ledger_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
	await admin.unsafe(`CREATE DATABASE ${name}`);
	const own = new URL(url ?? "");
	own.pathname = `/${name}`;
	return {
		url: own.toString(),
		drop: async () => {
			await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
			await admin.close();
		},
	};
}

async function withDatabase(
	test: (url: string, sql: SQL) => Promise<void>,
): Promise<void> {
	const database = await createDatabase();
	const sql = new SQL(database.url, { max: 4 });
	try {
		await test(database.url, sql);
	} finally {
		await sql.close();
		await database.drop();
	}
}

const ids = async (sql: SQL): Promise<string[]> =>
	(
		(await sql`SELECT id FROM roundtable_migrations ORDER BY applied_at, id`) as {
			id: string;
		}[]
	).map((row) => row.id);

describe("runMigrations", () => {
	test("refuses an id declared twice in a plugin before running any, and runs nothing for a plugin without migrations", async () => {
		const log: string[] = [];
		// Neither reaches a server: the duplicate is refused first, and no migration means no ledger.
		const sql = openPool("postgres://nobody@127.0.0.1:1/none");
		const error = await rejection(
			runMigrations(sql, [
				{
					name: "p",
					migrations: [recording("a", log), recording("a", log)],
				},
			]),
		);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain("migration p/a is declared twice");
		expect(log).toEqual([]);
		const empty = await runMigrations(sql, [{ name: "p" }]);
		await sql.close();
		expect(empty).toEqual({ applied: [], skipped: [], everyBoot: [] });
	});
});

describeDb("the migration ledger", () => {
	test("a fresh database records every once migration under plugin/name and runs the every-boot ones without recording them", async () => {
		await withDatabase(async (_url, sql) => {
			const log: string[] = [];
			const report = await runMigrations(sql, [
				{
					name: "first",
					migrations: [
						recording("a", log),
						{ ...recording("sync", log), runs: "every-boot" },
						recording("b", log),
					],
				},
				{ name: "second", migrations: [recording("a", log)] },
			]);
			expect(log).toEqual(["a", "sync", "b", "a"]);
			expect(report).toEqual({
				applied: ["first/a", "first/b", "second/a"],
				skipped: [],
				everyBoot: ["first/sync"],
			});
			expect((await ids(sql)).sort()).toEqual([
				"first/a",
				"first/b",
				"second/a",
			]);
			const [row] =
				await sql`SELECT plugin, name FROM roundtable_migrations WHERE id = 'first/b'`;
			expect(row).toEqual({ plugin: "first", name: "b" });
		});
	});

	test("a second run applies nothing new and runs the every-boot migrations again", async () => {
		await withDatabase(async (_url, sql) => {
			const log: string[] = [];
			const plugins = [
				{
					name: "p",
					migrations: [
						recording("once", log),
						{ ...recording("always", log), runs: "every-boot" as const },
					],
				},
			];
			await runMigrations(sql, plugins);
			log.length = 0;
			const report = await runMigrations(sql, plugins);
			expect(log).toEqual(["always"]);
			expect(report).toEqual({
				applied: [],
				skipped: ["p/once"],
				everyBoot: ["p/always"],
			});
		});
	});

	test("a failing migration records nothing, leaves its own changes undone, names its id, and stops the ones after it", async () => {
		await withDatabase(async (_url, sql) => {
			const log: string[] = [];
			const partial: Migration = {
				name: "partial",
				up: async (tx) => {
					await tx`CREATE TABLE half_done (id int)`;
					throw new Error("boom");
				},
			};
			const error = await rejection(
				runMigrations(sql, [
					{
						name: "p",
						migrations: [
							recording("good", log),
							partial,
							recording("after", log),
						],
					},
				]),
			);
			expect(error).toBeInstanceOf(MigrationError);
			expect((error as MigrationError).migration).toBe("p/partial");
			expect(String(error)).toContain("migration p/partial failed");
			expect(log).toEqual(["good"]);
			expect(await ids(sql)).toEqual(["p/good"]);
			const [table] = await sql`SELECT to_regclass('half_done') AS name`;
			expect(table?.name).toBeNull();
		});
	});

	test("a migration that opens its own transaction runs as a savepoint of the recorded one", async () => {
		await withDatabase(async (_url, sql) => {
			const nestedAndFailing: Migration = {
				name: "nested",
				up: async (tx) => {
					await tx`CREATE TABLE nested_probe (id int)`;
					await tx.begin(async (inner) => {
						await inner`INSERT INTO nested_probe VALUES (1)`;
					});
					throw new Error("after the inner transaction");
				},
			};
			expect(
				await rejection(
					runMigrations(sql, [{ name: "p", migrations: [nestedAndFailing] }]),
				),
			).toBeInstanceOf(MigrationError);
			// The inner transaction's work went with the outer one.
			const [table] = await sql`SELECT to_regclass('nested_probe') AS name`;
			expect(table?.name).toBeNull();
		});
	});

	test("two runners over one database apply a migration once in total", async () => {
		await withDatabase(async (databaseUrl, sql) => {
			let runs = 0;
			const slow: Migration = {
				name: "counted",
				up: async (tx) => {
					runs++;
					await Bun.sleep(100);
					await tx`CREATE TABLE IF NOT EXISTS counted (n int)`;
					await tx`INSERT INTO counted VALUES (1)`;
				},
			};
			const plugins = [{ name: "p", migrations: [slow] }];
			const other = new SQL(databaseUrl, { max: 2 });
			try {
				const [a, b] = await Promise.all([
					runMigrations(sql, plugins),
					runMigrations(other, plugins),
				]);
				expect(runs).toBe(1);
				expect([...a.applied, ...b.applied]).toEqual(["p/counted"]);
				expect([...a.skipped, ...b.skipped]).toEqual(["p/counted"]);
				const [count] = await sql`SELECT count(*)::int AS n FROM counted`;
				expect(count?.n).toBe(1);
			} finally {
				await other.close();
			}
		});
	});

	test("a database with the tables and no ledger, as a deployed one is, records every migration and keeps its rows", async () => {
		await withDatabase(async (_url, sql) => {
			const plugins = [
				{ name: "p", migrations: [tableMigration] },
				{ name: "q", migrations: [{ ...tableMigration, name: "again" }] },
			];
			// The build before the ledger: every migration's DDL ran at every boot, nothing was recorded.
			for (const plugin of plugins)
				for (const migration of plugin.migrations) await migration.up(sql);
			await sql.unsafe(`INSERT INTO ${table} (id, note) VALUES (1, 'kept')`);
			const report = await runMigrations(sql, plugins);
			expect(report.applied).toEqual(["p/test-table", "q/again"]);
			expect(await ids(sql)).toEqual(["p/test-table", "q/again"]);
			const rows: { id: number; note: string }[] = await sql.unsafe(
				`SELECT id, note FROM ${table} ORDER BY id`,
			);
			expect(rows).toEqual([{ id: 1, note: "kept" }]);
		});
	});

	test("migrateDatabase runs the plugins over a URL with the ledger, reports, and closes its pool", async () => {
		await withDatabase(async (databaseUrl, sql) => {
			const plugins = [{ name: "p", migrations: [tableMigration] }];
			expect(await migrateDatabase(databaseUrl, plugins)).toEqual({
				applied: ["p/test-table"],
				skipped: [],
				everyBoot: [],
			});
			expect(await migrateDatabase(databaseUrl, plugins)).toEqual({
				applied: [],
				skipped: ["p/test-table"],
				everyBoot: [],
			});
			expect(await ids(sql)).toEqual(["p/test-table"]);
		});
	});
});

describe("Roundtable migrations", () => {
	test("refuses migrations without a configured database, before any setup", async () => {
		const log: string[] = [];
		const { host } = roundtable([
			{
				name: "stores",
				migrations: [recording("a", log)],
				setup: () => {
					log.push("setup");
					return {};
				},
			},
		]);
		expect(await rejection(host.run())).toBeInstanceOf(PluginError);
		expect(log).toEqual([]);
	});

	test("without a database, reading it during setup is a plugin error", async () => {
		let error: unknown;
		const { host } = roundtable([
			{
				name: "reader",
				setup: ({ database }) => {
					try {
						database();
					} catch (e) {
						error = e;
					}
					return { events: {} };
				},
			},
		]);
		await host.run();
		expect(error).toBeInstanceOf(PluginError);
	});
});

describeDb("PostgreSQL", () => {
	let database: Awaited<ReturnType<typeof createDatabase>>;
	beforeEach(async () => {
		database = await createDatabase();
	});
	afterEach(async () => {
		await database.drop();
	});

	test("migrates every plugin in order before any setup, then closes the pool last", async () => {
		const log: string[] = [];
		let pool: SQL | undefined;
		const { host } = roundtable(
			[
				{
					name: "first",
					migrations: [recording("first", log), tableMigration],
					setup: ({ database }) => {
						log.push("setup first");
						pool = database();
						return {
							services: [{ name: "uses", stop: () => void log.push("stop") }],
						};
					},
				},
				{
					name: "second",
					migrations: [recording("second", log)],
					setup: () => {
						log.push("setup second");
						return {};
					},
				},
			],
			{ url: database.url },
		);
		await host.run();
		expect(log).toEqual(["first", "second", "setup first", "setup second"]);
		await pool?.unsafe(`INSERT INTO ${table} (id, note) VALUES (1, 'kept')`);
		expect(await host.shutdown("SIGTERM")).toBe(0);
		expect(log.at(-1)).toBe("stop");
		// The pool closed after the services stopped.
		expect(await rejection(pool?.unsafe("SELECT 1"))).toBeInstanceOf(Error);
	});

	test("a second boot over the existing schema keeps its rows, applies nothing again, and logs one migrations line each", async () => {
		const read: { id: number; note: string; added: string }[][] = [];
		const lines: { fields: unknown; message: unknown }[] = [];
		const logger = silentLogger();
		const record = (fields: unknown, message: unknown) => {
			if (message === "migrations") lines.push({ fields, message });
		};
		logger.info = record as typeof logger.info;
		for (let boot = 0; boot < 2; boot++) {
			const { host } = roundtable(
				[
					{
						name: "stores",
						migrations: [
							tableMigration,
							{ ...recording("sync", []), runs: "every-boot" },
						],
						setup: async ({ database }) => {
							if (boot === 0)
								await database().unsafe(
									`INSERT INTO ${table} (id, note) VALUES (1, 'kept')`,
								);
							read.push(
								await database().unsafe(
									`SELECT id, note, added FROM ${table} ORDER BY id`,
								),
							);
							return {};
						},
					},
				],
				{ url: database.url },
				logger,
			);
			await host.run();
			await host.shutdown("SIGTERM");
		}
		expect(read).toEqual([
			[{ id: 1, note: "kept", added: "x" }],
			[{ id: 1, note: "kept", added: "x" }],
		]);
		expect(lines.map((line) => line.fields)).toEqual([
			{ applied: ["stores/test-table"], skipped: 0, everyBoot: 1 },
			{ applied: [], skipped: 1, everyBoot: 1 },
		]);
	});

	test("a start that fails after the migrations closes the pool and stops what started", async () => {
		const log: string[] = [];
		let pool: SQL | undefined;
		const { host } = roundtable(
			[
				{
					name: "first",
					migrations: [tableMigration],
					setup: ({ database }) => {
						pool = database();
						return {
							services: [
								{ name: "up", start: () => void log.push("start up") },
								{ name: "gone", stop: () => void log.push("stop up") },
							],
						};
					},
				},
				{
					name: "second",
					setup: () => ({
						services: [
							{
								name: "boom",
								start: () => {
									throw new Error("port busy");
								},
							},
						],
					}),
				},
			],
			{ url: database.url },
		);
		expect(String(await rejection(host.run()))).toContain("port busy");
		expect(log).toEqual(["start up", "stop up"]);
		expect(await rejection(pool?.unsafe("SELECT 1"))).toBeInstanceOf(Error);
	});

	test("a failing migration stops the boot before any setup", async () => {
		const log: string[] = [];
		const { host } = roundtable(
			[
				{
					name: "broken",
					migrations: [recording("broken", log, true)],
					setup: () => {
						log.push("setup");
						return {};
					},
				},
			],
			{ url: database.url },
		);
		const error = await rejection(host.run());
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"plugin broken: migration broken/broken failed: ",
		);
		expect(String(error)).toContain(
			"Fix the migration or restore the database, then start again.",
		);
		expect((error as Error).cause).toBeInstanceOf(MigrationError);
		expect(log).toEqual(["broken"]);
	});
});
