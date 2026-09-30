import { expect, test } from "bun:test";
import { SQL } from "bun";
import { testPlugin } from "pi-roundtable/testing";
import { visitCounter } from "./migrations.ts";

const url = process.env.ROUNDTABLE_TEST_DATABASE_URL;

// The harness gives the plugin your database but does not migrate it: run the migrations first.
test.skipIf(!url)(
	"the tool counts visits in the plugin's own table",
	async () => {
		const sql = new SQL(url as string);
		try {
			for (const migration of visitCounter.migrations ?? []) {
				await migration.up(sql);
				await migration.up(sql); // Idempotent: the host runs it on every start.
			}
			const harness = await testPlugin(visitCounter, { database: sql });
			expect(await harness.runTool("visit_count", { place: "lab" })).toBe(
				"Visit 1 to lab.",
			);
			expect(await harness.runTool("visit_count", { place: "lab" })).toBe(
				"Visit 2 to lab.",
			);
			await harness.stop();
		} finally {
			await sql`DROP TABLE IF EXISTS visit_counter`;
			await sql.close();
		}
	},
);
