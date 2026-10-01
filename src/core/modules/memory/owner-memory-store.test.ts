import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";
import { MemoryError } from "../../domain/errors.ts";
import {
	describeDb,
	TEST_GUILD as OWNER_ID,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { setTimeZone, zonedDate } from "../../time.ts";
import { PgMemoryStore, searchTerms } from "./owner-memory-store.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let store: TestStore<PgMemoryStore>;

	const facts = async () => (await store.list()).map((memory) => memory.fact);

	beforeAll(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`DROP TABLE IF EXISTS owner_memory`;
		// The milestone 1 table, so opening it exercises the upgrade.
		await admin`
		CREATE TABLE owner_memory (
			id bigserial PRIMARY KEY,
			fact text NOT NULL CHECK (length(btrim(fact)) > 0),
			created_at timestamptz NOT NULL DEFAULT now()
		)`;
		await admin`INSERT INTO owner_memory (fact) VALUES ('old fact')`;
		await admin.close();
		store = await openTestStore(PgMemoryStore, OWNER_ID);
	});

	afterAll(async () => {
		await store.close();
	});

	describe("PgMemoryStore", () => {
		test("a milestone 1 row becomes a core fact", async () => {
			expect(await store.list()).toMatchObject([
				{ kind: "core", fact: "old fact", eventDate: null },
			]);
		});

		describe("after the upgrade", () => {
			beforeEach(async () => {
				for (const fact of await facts()) await store.remove(fact);
			});

			test("each speaker has a memory of their own, which no other reads or changes", async () => {
				const other = store.forSpeaker("900000000000000077");
				await store.add("lives in Taipei");
				await other.add("lives in Kaohsiung");
				await other.add("loves coffee", "note");
				expect((await store.list()).map((m) => m.fact)).toEqual([
					"lives in Taipei",
				]);
				expect((await other.list()).map((m) => m.fact)).toEqual([
					"lives in Kaohsiung",
					"loves coffee",
				]);
				expect((await store.search("coffee")).map((m) => m.fact)).toEqual([]);
				expect((await store.forPrompt("2026-09-30")).core).toHaveLength(1);
				const theirs = (await other.list())[0];
				expect(await store.removeById(theirs?.id ?? 0)).toBe(false);
				expect(
					await store.update(theirs?.id ?? 0, { fact: "x", kind: "core" }),
				).toBeUndefined();
				expect(await store.remove("lives in")).toEqual(["lives in Taipei"]);
				expect((await other.list()).map((m) => m.fact)).toEqual([
					"lives in Kaohsiung",
					"loves coffee",
				]);
				for (const fact of await other.list()) await other.removeById(fact.id);
			});

			test("adds facts of each kind in order and trims them", async () => {
				await store.add("  no coffee ");
				await store.add("writing a dungeon adventure", "note");
				await store.add("going to a whisky fair", "event", "2026-10-03");
				expect(await store.list()).toMatchObject([
					{ kind: "core", fact: "no coffee", eventDate: null },
					{
						kind: "note",
						fact: "writing a dungeon adventure",
						eventDate: null,
					},
					{
						kind: "event",
						fact: "going to a whisky fair",
						eventDate: "2026-10-03",
					},
				]);
			});

			test("an event needs a date, and only an event has one", async () => {
				expect(store.add("a meeting", "event")).rejects.toBeInstanceOf(
					MemoryError,
				);
				expect(store.add("a meeting", "event", "10/3")).rejects.toBeInstanceOf(
					MemoryError,
				);
				expect(
					store.add("no coffee", "core", "2026-10-03"),
				).rejects.toBeInstanceOf(MemoryError);
			});

			test("the prompt carries core facts and events not yet passed, never notes", async () => {
				await store.add("no coffee");
				await store.add("writing a dungeon adventure", "note");
				await store.add("last week's game", "event", "2026-09-20");
				await store.add("today's game", "event", "2026-09-26");
				await store.add("next week's game", "event", "2026-10-03");
				const prompt = await store.forPrompt("2026-09-26");
				expect(prompt.core.map((m) => m.fact)).toEqual(["no coffee"]);
				expect(prompt.events.map((m) => m.fact)).toEqual([
					"today's game",
					"next week's game",
				]);
			});

			test("search finds every kind, most matched terms first", async () => {
				await store.add("Obsidian knowledge base uses MOC notes", "note");
				await store.add("Obsidian path is ~/obsidian", "note");
				await store.add("last week's game", "event", "2026-09-20");
				await store.add("no coffee");
				const found = await store.search("obsidian MOC");
				expect(found.map((m) => m.fact)).toEqual([
					"Obsidian knowledge base uses MOC notes",
					"Obsidian path is ~/obsidian",
				]);
				expect((await store.search("game")).map((m) => m.kind)).toEqual([
					"event",
				]);
				expect(await store.search("tea")).toEqual([]);
				expect(store.search("   ")).rejects.toBeInstanceOf(MemoryError);
			});

			test("search treats terms literally, not as patterns", async () => {
				await store.add("100% sure");
				await store.add("1000 sure");
				expect((await store.search("0%")).map((m) => m.fact)).toEqual([
					"100% sure",
				]);
			});

			test("facts survive a new connection", async () => {
				await store.add("lives in Taipei");
				const other = await openTestStore(PgMemoryStore, OWNER_ID);
				expect((await other.list()).map((m) => m.fact)).toEqual([
					"lives in Taipei",
				]);
				await other.close();
			});

			test("remove deletes every fact containing the text, case-insensitively", async () => {
				await store.add("Prefers Bun over Node");
				await store.add("bun lover", "note");
				await store.add("no coffee");
				expect(await store.remove("BUN")).toEqual([
					"Prefers Bun over Node",
					"bun lover",
				]);
				expect(await facts()).toEqual(["no coffee"]);
				expect(await store.remove("tea")).toEqual([]);
			});

			test("update replaces one memory's text, kind, and date under the same rules", async () => {
				const note = await store.add("writing a dungeon adventure", "note");
				const other = await store.add("no coffee");
				expect(
					await store.update(note.id, {
						fact: " dungeon session ",
						kind: "event",
						eventDate: "2026-10-03",
					}),
				).toEqual({
					id: note.id,
					kind: "event",
					fact: "dungeon session",
					eventDate: "2026-10-03",
				});
				expect(
					await store.update(note.id, {
						fact: "dungeon session",
						kind: "note",
					}),
				).toMatchObject({ kind: "note", eventDate: null });
				expect(
					store.update(note.id, { fact: "a meeting", kind: "event" }),
				).rejects.toBeInstanceOf(MemoryError);
				expect(
					store.update(note.id, { fact: " ", kind: "note" }),
				).rejects.toBeInstanceOf(MemoryError);
				expect(
					await store.update(other.id + 1000, { fact: "x", kind: "core" }),
				).toBeUndefined();
				expect(await facts()).toEqual(["dungeon session", "no coffee"]);
			});

			test("removeById deletes exactly one memory", async () => {
				const first = await store.add("Prefers Bun");
				await store.add("Prefers Bun too");
				expect(await store.removeById(first.id)).toBe(true);
				expect(await store.removeById(first.id)).toBe(false);
				expect(await facts()).toEqual(["Prefers Bun too"]);
			});

			test("empty input is rejected", async () => {
				expect(store.add("   ")).rejects.toBeInstanceOf(MemoryError);
				expect(store.remove("")).rejects.toBeInstanceOf(MemoryError);
			});
		});
	});
});

describe("helpers", () => {
	test("search terms split on whitespace, lowercased and deduplicated", () => {
		expect(searchTerms("  Obsidian  MOC obsidian\nknowledge ")).toEqual([
			"obsidian",
			"moc",
			"knowledge",
		]);
	});

	test("today is the date in the configured zone", () => {
		setTimeZone("Asia/Taipei");
		try {
			expect(zonedDate(new Date("2026-09-26T16:30:00Z"))).toBe("2026-09-27");
			expect(zonedDate(new Date("2026-09-26T15:30:00Z"))).toBe("2026-09-26");
		} finally {
			useTestLocale();
		}
	});
});
