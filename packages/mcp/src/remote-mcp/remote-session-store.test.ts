import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { RemoteSessionStore } from "./remote-session-store.ts";

const ADA = "966666600000000001";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const OWNED = "33333333-3333-4333-8333-333333333333";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("RemoteSessionStore.adopt", () => {
	let store: TestStore<RemoteSessionStore>;
	let sql: SQL;

	beforeAll(async () => {
		sql = new SQL(testDatabaseUrl);
		await sql`DROP TABLE IF EXISTS remote_agent_sessions`;
		store = await openTestStore(RemoteSessionStore);
	});

	beforeEach(async () => {
		// Two sessions 0.8 opened, and one a 0.9 start opened for Ada.
		await sql`DELETE FROM remote_agent_sessions`;
		await sql`
			INSERT INTO remote_agent_sessions (id, principal_id) VALUES
				(${FIRST}, NULL), (${SECOND}, NULL), (${OWNED}, ${ADA})`;
	});

	afterAll(async () => {
		await sql`DELETE FROM remote_agent_sessions`;
		await sql.close();
		await store.close();
	});

	const unowned = async () =>
		(
			await sql`SELECT id FROM remote_agent_sessions WHERE principal_id IS NULL ORDER BY id`
		).map((row: { id: string }) => row.id);

	test("hands each session of no principal over once, telling which", async () => {
		const handed: string[] = [];
		const ids = await store.adopt(ADA, async (id) => {
			handed.push(id);
		});
		expect(ids.toSorted()).toEqual([FIRST, SECOND]);
		expect(handed.toSorted()).toEqual([FIRST, SECOND]);
		expect(await unowned()).toEqual([]);
		expect(await store.adopt(ADA, async () => {})).toEqual([]);
	});

	test("a hand-over that fails leaves every session unowned, for the next start to hand over", async () => {
		const failed = store.adopt(ADA, async (id) => {
			if (id === SECOND) throw new Error("registry down");
		});
		expect(failed).rejects.toThrow("registry down");
		await failed.catch(() => undefined);
		expect(await unowned()).toEqual([FIRST, SECOND]);
		expect((await store.adopt(ADA, async () => {})).toSorted()).toEqual([
			FIRST,
			SECOND,
		]);
	});

	test("starts racing to adopt hand each session over exactly once", async () => {
		const handed: string[] = [];
		const results = await Promise.all(
			[0, 1, 2].map(() =>
				store.adopt(ADA, async (id) => {
					handed.push(id);
				}),
			),
		);
		expect(results.flat().toSorted()).toEqual([FIRST, SECOND]);
		expect(handed.toSorted()).toEqual([FIRST, SECOND]);
	});
});
