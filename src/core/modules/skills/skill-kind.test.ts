import { afterEach, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../../db/migrations.ts";
import {
	describeDb,
	migratedPool,
	TEST_GUILD,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { LEGACY_WRITTEN_KIND, SkillStore } from "./skill-store.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("the written skill kind", () => {
	let sql: SQL;

	beforeEach(async () => {
		const admin = new SQL(testDatabaseUrl);
		for (const table of ["skills", "skill_groups", "agent_skills"])
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		// The tables as they were when an agent-written skill was stored under the legacy kind.
		sql = await migratedPool(SkillStore.migration);
		await sql`INSERT INTO skills (name, kind, description, body)
			VALUES ('notes', ${LEGACY_WRITTEN_KIND}, 'Take notes.', 'Body.')`;
		await sql`INSERT INTO skills (name, kind, repo, path)
			VALUES ('linked-one', 'linked', 'owner/repo', 'skills/linked-one')`;
	});

	afterEach(async () => {
		await sql.close();
	});

	const kinds = async () =>
		(await sql`SELECT name, kind FROM skills ORDER BY name`) as {
			name: string;
			kind: string;
		}[];

	test("a legacy row becomes written, a linked row is left alone, and the store reads it", async () => {
		await migrate(sql, SkillStore.migrations(TEST_GUILD));
		expect(await kinds()).toEqual([
			{ name: "linked-one", kind: "linked" },
			{ name: "notes", kind: "written" },
		]);
		const store = await SkillStore.attach(sql, TEST_GUILD);
		expect(store.skill("notes")?.kind).toBe("written");
	});

	test("running the migration again changes nothing", async () => {
		await migrate(sql, SkillStore.migrations(TEST_GUILD));
		const before = await kinds();
		await migrate(sql, SkillStore.migrations(TEST_GUILD));
		expect(await kinds()).toEqual(before);
	});
});
