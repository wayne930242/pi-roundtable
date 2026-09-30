import { expect, test } from "bun:test";
import type { Migration } from "../../core/db/migrations.ts";
import { MigrationError } from "../../core/errors.ts";
import { describeDb, testDatabaseUrl } from "../../core/testing/database.ts";
import { Project } from "../project.ts";
import { fakePorts, validConfig } from "../testing/fixtures.ts";
import { checkDatabase, type DatabasePort, postgres } from "./database.ts";

const migration: Migration = { name: "doctor-probe", up: async () => {} };
const withMigration = (name = "probe") =>
	new Project(
		"/x",
		fakePorts(validConfig, {
			define: async () => ({
				options: { logger: {} as never },
				plugins: [{ name, setup: () => ({}), migrations: [migration] }],
			}),
		}),
	);

test("passes when the database answers and the migrations run, without printing the password", async () => {
	const asked: unknown[] = [];
	const port: DatabasePort = {
		check: async (url, migrations) => void asked.push([url, migrations]),
	};
	const result = await checkDatabase(withMigration(), port);
	expect(result.status).toBe("ok");
	if (result.status === "ok") {
		expect(result.detail).toContain("db.example.test:5432/bot");
		expect(result.detail).not.toContain("secret");
	}
	expect(asked).toEqual([[validConfig.database.url, [migration]]]);
});

test("fails when the database is unreachable, naming it and saying how to start one", async () => {
	const port: DatabasePort = {
		check: async () => {
			throw new Error("connection refused");
		},
	};
	const result = await checkDatabase(withMigration(), port);
	expect(result.status).toBe("fail");
	if (result.status === "fail") {
		expect(result.problem).toContain("db.example.test:5432/bot");
		expect(result.problem).toContain("connection refused");
		expect(result.problem).not.toContain("secret");
		expect(result.fix).toContain("docker compose up -d");
	}
});

test("fails when a migration fails, naming it", async () => {
	const port: DatabasePort = {
		check: async () => {
			throw new MigrationError("owner-memory", new Error("permission denied"));
		},
	};
	const result = await checkDatabase(withMigration(), port);
	expect(result.status).toBe("fail");
	if (result.status === "fail") {
		expect(result.problem).toContain("migration owner-memory failed");
		expect(result.problem).toContain("permission denied");
	}
});

test("still tests reachability from the raw url while the configuration is invalid, and skips without a url", async () => {
	const asked: unknown[] = [];
	const port: DatabasePort = {
		check: async (url, migrations) => void asked.push([url, migrations]),
	};
	const invalid = new Project(
		"/x",
		fakePorts({ database: { url: "postgres://h/d" } }),
	);
	const result = await checkDatabase(invalid, port);
	expect(result.status).toBe("ok");
	expect(asked).toEqual([["postgres://h/d", undefined]]);
	const none = await checkDatabase(new Project("/x", fakePorts({})), port);
	expect(none.status).toBe("skipped");
});

describeDb("against PostgreSQL", () => {
	test("runs the migrations inside a rolled-back transaction, including ones that open their own", async () => {
		const table = `doctor_probe_${Date.now()}`;
		const run: Migration = {
			name: "creates",
			up: async (sql) => {
				await sql`create table ${sql(table)} (id int)`;
				await sql.begin(async (inner) => {
					await inner`insert into ${inner(table)} values (1)`;
				});
			},
		};
		await postgres.check(testDatabaseUrl, [run]);
		const pool = new Bun.SQL(testDatabaseUrl, { max: 1 });
		try {
			const [found] = await pool`select to_regclass(${table}) as name`;
			expect(found?.name).toBeNull();
		} finally {
			await pool.close();
		}
	});

	test("reports a failing migration as a MigrationError and an unreachable server as an error", async () => {
		const broken: Migration = {
			name: "broken",
			up: async (sql) => {
				await sql`select * from no_such_table_anywhere`;
			},
		};
		await expect(
			postgres.check(testDatabaseUrl, [broken]),
		).rejects.toBeInstanceOf(MigrationError);
		await expect(
			postgres.check("postgres://nobody@127.0.0.1:1/none", undefined),
		).rejects.toThrow();
	});
});
