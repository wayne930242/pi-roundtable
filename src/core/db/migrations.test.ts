import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { MigrationError, PluginError } from "../errors.ts";
import { Roundtable } from "../host.ts";
import { silentLogger } from "../log.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { type Migration, migrate, openPool } from "./migrations.ts";

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

function roundtable(
	plugins: RoundtablePlugin[],
	database?: { url: string },
): { host: Roundtable; exits: number[] } {
	const exits: number[] = [];
	const host = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50 },
			exit: (code) => exits.push(code),
			...(database ? { database } : {}),
		},
		plugins,
	);
	return { host, exits };
}

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

	async function reset(): Promise<void> {
		const admin = openPool(url ?? "");
		await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
	}

	test("migrates every plugin in order before any setup, then closes the pool last", async () => {
		await reset();
		const log: string[] = [];
		let pool: SQL | undefined;
		const { host, exits } = roundtable(
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
			{ url: url ?? "" },
		);
		await host.run();
		expect(log).toEqual(["first", "second", "setup first", "setup second"]);
		await pool?.unsafe(`INSERT INTO ${table} (id, note) VALUES (1, 'kept')`);
		await host.shutdown("SIGTERM");
		expect(log.at(-1)).toBe("stop");
		expect(exits).toEqual([0]);
		// The pool closed after the services stopped.
		expect(await rejection(pool?.unsafe("SELECT 1"))).toBeInstanceOf(Error);
	});

	test("a second boot over the existing schema keeps its rows", async () => {
		const read: { id: number; note: string; added: string }[][] = [];
		for (let boot = 0; boot < 2; boot++) {
			const { host } = roundtable(
				[
					{
						name: "stores",
						migrations: [tableMigration],
						setup: async ({ database }) => {
							read.push(
								await database().unsafe(
									`SELECT id, note, added FROM ${table} ORDER BY id`,
								),
							);
							return {};
						},
					},
				],
				{ url: url ?? "" },
			);
			await host.run();
			await host.shutdown("SIGTERM");
		}
		expect(read).toEqual([
			[{ id: 1, note: "kept", added: "x" }],
			[{ id: 1, note: "kept", added: "x" }],
		]);
		await reset();
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
			{ url: url ?? "" },
		);
		const error = await rejection(host.run());
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain("plugin broken: migration broken failed: ");
		expect(String(error)).toContain(
			"Fix the migration or restore the database, then start again.",
		);
		expect((error as Error).cause).toBeInstanceOf(MigrationError);
		expect(log).toEqual(["broken"]);
	});
});
