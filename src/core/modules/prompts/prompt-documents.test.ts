import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { Migration } from "../../db/migrations.ts";
import { AgentError } from "../../domain/errors.ts";
import { type Logger, silentLogger } from "../../log.ts";
import {
	describeDb,
	openTestStore,
	TEST_GUILD,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { PgPromptDocuments, PromptConflictError } from "./prompt-documents.ts";

type Row = Record<string, unknown>;

/** Just enough of PostgreSQL for the documents' statements, in memory. */
function fakeDatabase() {
	const overrides = new Map<string, Row>();
	const history: Row[] = [];
	let nextId = 1;
	const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").replace(/\s+/g, " ").trim();
		const v = values;
		await Promise.resolve();
		if (text.startsWith("SELECT name, text, by_name, at FROM prompt_overrides"))
			return [...overrides.values()].filter((row) => row.guild === v[0]);
		if (text.startsWith("INSERT INTO prompt_overrides")) {
			overrides.set(`${v[0]}/${v[1]}`, {
				guild: v[0],
				name: v[1],
				text: v[2],
				by_name: v[3],
				at: v[4],
			});
			return [];
		}
		if (text.startsWith("DELETE FROM prompt_overrides")) {
			overrides.delete(`${v[0]}/${v[1]}`);
			return [];
		}
		if (text.startsWith("INSERT INTO prompt_history")) {
			history.push({
				id: nextId++,
				guild: v[0],
				kind: v[1],
				name: v[2],
				action: v[3],
				text: v[4],
				previous: v[5],
				by_name: v[6],
				at: new Date(),
			});
			return [];
		}
		if (text.startsWith("DELETE FROM prompt_history")) return [];
		if (text.startsWith("SELECT id, action, text, previous, by_name, at FROM"))
			return history
				.filter((row) => row.kind === v[1] && row.name === v[2])
				.reverse()
				.slice(0, Number(v[3]));
		throw new Error(`the fake does not know: ${text}`);
	};
	const sql = Object.assign(run, {
		begin: (body: (tx: typeof run) => Promise<unknown>) => body(run),
	}) as unknown as SQL;
	return { sql, overrides, history };
}

const spec = (text = "File text.") => ({
	id: "shared",
	label: "Shared prompt",
	default: text,
});

async function documentsOver(db: ReturnType<typeof fakeDatabase>) {
	const documents = await PgPromptDocuments.attach(db.sql, TEST_GUILD);
	documents.register(spec());
	return documents;
}

describe("prompt documents", () => {
	test("the file version is in force until the owner overrides it", async () => {
		const documents = await documentsOver(fakeDatabase());
		expect(documents.text("shared")).toBe("File text.");
		expect(documents.get("shared")).toMatchObject({
			overridden: false,
			differs: false,
			text: "File text.",
			fileText: "File text.",
		});
		await documents.set("shared", "Owner text.", "Riley");
		expect(documents.text("shared")).toBe("Owner text.");
		const view = documents.get("shared");
		expect(view).toMatchObject({
			overridden: true,
			differs: true,
			text: "Owner text.",
			fileText: "File text.",
			override: { by: "Riley" },
		});
	});

	test("a handle reads the text in force at every call, so an edit applies at once", async () => {
		const documents = await PgPromptDocuments.attach(
			fakeDatabase().sql,
			TEST_GUILD,
		);
		const handle = documents.register(spec());
		expect(handle.text()).toBe("File text.");
		await documents.set("shared", "Owner text.", "Riley");
		expect(handle.text()).toBe("Owner text.");
		await documents.revert("shared", "Riley");
		expect(handle.text()).toBe("File text.");
	});

	test("a default given as a function follows its file", async () => {
		let file = "One.";
		const documents = await PgPromptDocuments.attach(
			fakeDatabase().sql,
			TEST_GUILD,
		);
		documents.register({ ...spec(), default: () => file });
		expect(documents.text("shared")).toBe("One.");
		file = "Two.";
		expect(documents.text("shared")).toBe("Two.");
	});

	test("every change is kept with who, when, the new text and the text it replaced", async () => {
		const documents = await documentsOver(fakeDatabase());
		await documents.set("shared", "First.", "Riley");
		await documents.set("shared", "Second.", "Sam");
		await documents.revert("shared", "Riley");
		const versions = await documents.history("shared");
		expect(
			versions.map(({ action, text, previous, by }) => ({
				action,
				text,
				previous,
				by,
			})),
		).toEqual([
			{
				action: "revert",
				text: "File text.",
				previous: "Second.",
				by: "Riley",
			},
			{ action: "set", text: "Second.", previous: "First.", by: "Sam" },
			{ action: "set", text: "First.", previous: "File text.", by: "Riley" },
		]);
		expect(versions[0]?.at).toBeInstanceOf(Date);
	});

	test("reverting drops the override and says so in the history", async () => {
		const db = fakeDatabase();
		const documents = await documentsOver(db);
		await documents.set("shared", "Owner text.", "Riley");
		const view = await documents.revert("shared", "Riley");
		expect(view).toMatchObject({ overridden: false, text: "File text." });
		expect(db.overrides.size).toBe(0);
	});

	test("setting the file version's own text reverts instead of storing a copy", async () => {
		const db = fakeDatabase();
		const documents = await documentsOver(db);
		await documents.set("shared", "Owner text.", "Riley");
		await documents.set("shared", "File text.", "Riley");
		expect(documents.get("shared")?.overridden).toBe(false);
		expect(db.overrides.size).toBe(0);
		expect((await documents.history("shared"))[0]?.action).toBe("revert");
	});

	test("refuses empty, oversized and unchanged text, and reverting a file version", async () => {
		const documents = await PgPromptDocuments.attach(
			fakeDatabase().sql,
			TEST_GUILD,
		);
		documents.register({ ...spec(), maxChars: 10 });
		await expect(documents.set("shared", "  ", "Riley")).rejects.toThrow(
			AgentError,
		);
		await expect(
			documents.set("shared", "x".repeat(11), "Riley"),
		).rejects.toThrow("1 to 10 characters");
		await expect(
			documents.set("shared", "File text.", "Riley"),
		).rejects.toThrow("already in force");
		await expect(documents.revert("shared", "Riley")).rejects.toThrow(
			"no override",
		);
		await expect(documents.set("nope", "x", "Riley")).rejects.toThrow(
			'no prompt document "nope"',
		);
	});

	test("refuses a bad or repeated id and a missing label", async () => {
		const documents = await PgPromptDocuments.attach(
			fakeDatabase().sql,
			TEST_GUILD,
		);
		documents.register(spec());
		expect(() => documents.register(spec())).toThrow("already exists");
		expect(() => documents.register({ ...spec(), id: "Bad Id" })).toThrow(
			"not a usable prompt document id",
		);
		expect(() =>
			documents.register({ ...spec(), id: "other", label: " " }),
		).toThrow("needs a label");
	});

	test("a second owner write after the first reads what the first committed", async () => {
		const documents = await documentsOver(fakeDatabase());
		await Promise.all([
			documents.set("shared", "A.", "Riley"),
			documents.set("shared", "B.", "Sam"),
		]);
		const versions = await documents.history("shared");
		expect(versions.map((version) => version.previous)).toEqual([
			"A.",
			"File text.",
		]);
		expect(documents.text("shared")).toBe("B.");
	});

	test("two saves from the same base give one write and one conflict that carries what was written", async () => {
		const db = fakeDatabase();
		const documents = await documentsOver(db);
		const [first, second] = await Promise.allSettled([
			documents.set("shared", "A.", "Riley", "File text."),
			documents.set("shared", "B.", "Sam", "File text."),
		]);
		expect(first.status).toBe("fulfilled");
		expect(second.status).toBe("rejected");
		const refused = (second as PromiseRejectedResult).reason;
		expect(refused).toBeInstanceOf(PromptConflictError);
		expect((refused as PromptConflictError).current).toMatchObject({
			id: "shared",
			text: "A.",
			override: { by: "Riley" },
		});
		expect(documents.text("shared")).toBe("A.");
		expect((await documents.history("shared")).map((v) => v.by)).toEqual([
			"Riley",
		]);
	});

	test("a revert from a base that is no longer in force is a conflict, and the override stays", async () => {
		const documents = await documentsOver(fakeDatabase());
		await documents.set("shared", "Mine.", "Riley");
		const [saved, reverted] = await Promise.allSettled([
			documents.set("shared", "Theirs.", "Sam", "Mine."),
			documents.revert("shared", "Riley", "Mine."),
		]);
		expect(saved.status).toBe("fulfilled");
		expect(reverted.status).toBe("rejected");
		expect((reverted as PromiseRejectedResult).reason).toBeInstanceOf(
			PromptConflictError,
		);
		expect(documents.text("shared")).toBe("Theirs.");
		expect(documents.get("shared")?.overridden).toBe(true);
		// With the base in force, the same revert goes through.
		await documents.revert("shared", "Riley", "Theirs.");
		expect(documents.text("shared")).toBe("File text.");
	});

	test("a call without a base writes as before", async () => {
		const documents = await documentsOver(fakeDatabase());
		await documents.set("shared", "A.", "Riley");
		await documents.set("shared", "B.", "Sam");
		await documents.revert("shared", "Riley");
		expect(documents.text("shared")).toBe("File text.");
	});

	describe("a file version that cannot be read", () => {
		const errors: { fields: Record<string, unknown>; message: string }[] = [];
		const logger = {
			...silentLogger(),
			error: (fields: Record<string, unknown>, message: string) =>
				errors.push({ fields, message }),
		} as unknown as Logger;
		let file: string | Error;
		const readable = () => {
			if (file instanceof Error) throw file;
			return file;
		};

		async function withTwoDocuments(db = fakeDatabase()) {
			errors.length = 0;
			file = "File text.";
			const documents = await PgPromptDocuments.attach(
				db.sql,
				TEST_GUILD,
				logger,
			);
			documents.register({ ...spec(), default: readable });
			documents.register({ ...spec(), id: "guest", label: "Guest prompt" });
			return documents;
		}

		test("a default that cannot be read when it is registered stops the host", async () => {
			const documents = await PgPromptDocuments.attach(
				fakeDatabase().sql,
				TEST_GUILD,
			);
			expect(() =>
				documents.register({
					...spec(),
					default: () => {
						throw new Error("ENOENT: persona/merlin.md");
					},
				}),
			).toThrow(/"shared" has no readable file version: ENOENT/);
			expect(documents.get("shared")).toBeUndefined();
		});

		test("reading the text fails with the document's id and logs an error, never the old text", async () => {
			const documents = await withTwoDocuments();
			expect(documents.text("shared")).toBe("File text.");
			file = new Error("ENOENT: persona/merlin.md");
			expect(() => documents.text("shared")).toThrow(
				/prompt document "shared" cannot be read: ENOENT/,
			);
			expect(errors.map((line) => line.fields.document)).toEqual(["shared"]);
			// Another document is unaffected.
			expect(documents.text("guest")).toBe("File text.");
		});

		test("the list shows the others and marks the broken document instead of failing for all", async () => {
			const documents = await withTwoDocuments();
			file = new Error("ENOENT: persona/merlin.md");
			const views = documents.list();
			expect(views.map((view) => view.id)).toEqual(["shared", "guest"]);
			expect(views[0]).toMatchObject({
				id: "shared",
				broken: "ENOENT: persona/merlin.md",
				fileText: "",
				text: "",
				differs: false,
			});
			expect(views[1]).toMatchObject({ id: "guest", text: "File text." });
			expect(views[1]?.broken).toBeUndefined();
			expect(documents.get("shared")?.broken).toContain("ENOENT");
		});

		test("an override still applies while the file cannot be read, but the document cannot be changed until it can", async () => {
			const db = fakeDatabase();
			const documents = await withTwoDocuments(db);
			await documents.set("shared", "Owner text.", "Riley");
			file = new Error("ENOENT: persona/merlin.md");
			expect(documents.text("shared")).toBe("Owner text.");
			expect(documents.get("shared")).toMatchObject({
				text: "Owner text.",
				broken: "ENOENT: persona/merlin.md",
			});
			await expect(documents.set("shared", "Other.", "Riley")).rejects.toThrow(
				/prompt document "shared" cannot be read/,
			);
			await expect(documents.revert("shared", "Riley")).rejects.toThrow(
				/prompt document "shared" cannot be read/,
			);
			expect(documents.text("shared")).toBe("Owner text.");
			// The file is back: the document works again.
			file = "File text.";
			expect(documents.get("shared")?.broken).toBeUndefined();
			await documents.revert("shared", "Riley");
			expect(documents.text("shared")).toBe("File text.");
		});

		test("the start-up log reports it as an error naming the document", async () => {
			const db = fakeDatabase();
			const documents = await withTwoDocuments(db);
			await documents.set("shared", "Owner text.", "Riley");
			file = new Error("ENOENT: persona/merlin.md");
			errors.length = 0;
			documents.logOverrides(logger);
			expect(errors.map((line) => line.fields.document)).toEqual(["shared"]);
		});
	});

	test("a restart reads the overrides back", async () => {
		const db = fakeDatabase();
		const documents = await documentsOver(db);
		await documents.set("shared", "Owner text.", "Riley");
		const again = await documentsOver(db);
		expect(again.text("shared")).toBe("Owner text.");
		expect(again.get("shared")?.override?.by).toBe("Riley");
	});

	test("the start-up log names each document that differs from its file", async () => {
		const db = fakeDatabase();
		const documents = await documentsOver(db);
		await documents.set("shared", "Owner text.", "Riley");
		db.overrides.set(`${TEST_GUILD}/gone`, {
			guild: TEST_GUILD,
			name: "gone",
			text: "x",
			by_name: "Riley",
			at: new Date(),
		});
		const again = await documentsOver(db);
		const lines: { fields: Record<string, unknown>; message: string }[] = [];
		const logger = {
			...silentLogger(),
			warn: (fields: Record<string, unknown>, message: string) =>
				lines.push({ fields, message }),
		} as unknown as Logger;
		again.logOverrides(logger);
		expect(lines.map((line) => line.fields.document).sort()).toEqual([
			"gone",
			"shared",
		]);
		expect(
			lines.find((line) => line.fields.document === "shared")?.message,
		).toContain("differs from its file version");
	});
});

const documentsStore = {
	migration: PgPromptDocuments.migrations()[0] as Migration,
	migrations: (_guild: string) => PgPromptDocuments.migrations(),
	attach: (sql: SQL, guild: string) => PgPromptDocuments.attach(sql, guild),
};

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("prompt documents in PostgreSQL", () => {
	let store: TestStore<PgPromptDocuments>;

	beforeEach(async () => {
		await store?.close();
		// The rows only: the table belongs to the host's migrations, which a test must not drop.
		const admin = new SQL(testDatabaseUrl);
		const migrations = PgPromptDocuments.migrations();
		for (const migration of migrations) await migration.up(admin);
		await admin.unsafe("DELETE FROM prompt_overrides");
		await admin.unsafe("DELETE FROM prompt_history");
		await admin.close();
		store = await openTestStore(documentsStore, TEST_GUILD);
		store.register(spec());
	});

	afterAll(async () => {
		await store.close();
	});

	test("an override and its history survive a restart, and a revert removes the override", async () => {
		await store.set("shared", "Owner text.", "Riley");
		await store.set("shared", "Later text.", "Sam");
		const again = await openTestStore(documentsStore, TEST_GUILD);
		again.register(spec());
		expect(again.text("shared")).toBe("Later text.");
		const versions = await again.history("shared");
		expect(versions.map((version) => version.by)).toEqual(["Sam", "Riley"]);
		expect(versions[0]?.previous).toBe("Owner text.");
		await again.revert("shared", "Sam");
		await again.close();
		const last = await openTestStore(documentsStore, TEST_GUILD);
		last.register(spec());
		expect(last.text("shared")).toBe("File text.");
		expect(last.get("shared")?.overridden).toBe(false);
		await last.close();
	});

	test("another guild's overrides are not read", async () => {
		await store.set("shared", "Owner text.", "Riley");
		const other = await openTestStore(documentsStore, "900000000000000002");
		other.register(spec());
		expect(other.text("shared")).toBe("File text.");
		await other.close();
	});
});
