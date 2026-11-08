import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import {
	describeDb,
	servicePair,
	testDatabaseUrl,
	testPlugin,
} from "pi-roundtable/testing";
import { CODING, coding } from "./coding-plugin.ts";
import {
	CODING_SETTINGS_MIGRATION,
	type SettingsPage,
	settingsWording,
	WEB_APP,
} from "./coding-settings.ts";

const OWNER = { tier: "owner" as const };
const ADMIN = { tier: "admin" as const };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The coding plugin under test with a web app that keeps the page it registers. */
async function harness(options: { maxWorkers?: number; database?: SQL } = {}) {
	const shelfDir = mkdtempSync(join(tmpdir(), "coding-settings-"));
	cleanups.push(() => rmSync(shelfDir, { recursive: true, force: true }));
	const pages: SettingsPage[] = [];
	const changed: (string | undefined)[] = [];
	const plugin = await testPlugin(
		coding({
			shelfDir,
			model: "a/b",
			worker: { run: async () => "" },
			...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}),
			...(options.database ? { settingsInDatabase: true } : {}),
		}),
		{
			services: [
				servicePair(WEB_APP, {
					registerPage: (page) => pages.push(page),
					pages: { changed: (id) => changed.push(id) },
				}),
			],
			...(options.database ? { database: options.database } : {}),
		},
	);
	cleanups.push(() => plugin.stop());
	const page = pages[0];
	if (!page) throw new Error("no settings page was registered");
	/** The limit the desk holds now, as the form shows it. */
	const max = async () => {
		const form = (await page.view(OWNER)).sections[1];
		return form?.kind === "form" ? Number(form.form.fields[0]?.initial) : 0;
	};
	return { page, changed, max };
}

test("the Settings page is the owner's, shows the limit and counts, and a save applies at once", async () => {
	const { page, changed, max } = await harness({ maxWorkers: 2 });
	expect([page.id, page.place]).toEqual(["coding-workers", "settings"]);
	expect(page.visible(OWNER)).toBe(true);
	expect(page.visible(ADMIN)).toBe(false);
	expect(page.visible({ tier: "member" })).toBe(false);
	const view = await page.view(OWNER);
	expect(view.sections[0]).toEqual({
		kind: "markdown",
		text: "At most 2 at once. Running now: 0. Waiting in the queue: 0.",
	});
	const form = view.sections[1];
	expect(form?.kind === "form" && form.form.fields[0]?.initial).toBe("2");
	expect(await page.act(ADMIN, "save", { maxWorkers: "8" })).toEqual({
		ok: false,
		error: "Only an owner changes this.",
	});
	expect(await max()).toBe(2);
	for (const bad of ["0", "65", "2.5", "", "four"])
		expect(await page.act(OWNER, "save", { maxWorkers: bad })).toMatchObject({
			ok: false,
			field: "maxWorkers",
		});
	expect(changed).toEqual([]);
	expect(await page.act(OWNER, "save", { maxWorkers: " 8 " })).toEqual({
		ok: true,
		notice: "Up to 8 coding workers now run at once.",
	});
	expect(await max()).toBe(8);
	expect(changed).toEqual(["coding-workers"]);
});

test("the zh-TW wording fills placeholders, and a host's own entry wins", () => {
	const t = settingsWording("zh-TW", { Save: "Keep" });
	expect(t("Save")).toBe("Keep");
	expect(t("Give a whole number from 1 to {most}.", { most: 64 })).toContain(
		"64",
	);
	expect(t("Give a whole number from 1 to {most}.", { most: 64 })).not.toBe(
		"Give a whole number from 1 to 64.",
	);
	expect(settingsWording("en")("Save")).toBe("Save");
});

test("setup reads no stored limit; the coding-desk service reads it at start, as Roundtable.check() needs", async () => {
	const shelfDir = mkdtempSync(join(tmpdir(), "coding-settings-"));
	cleanups.push(() => rmSync(shelfDir, { recursive: true, force: true }));
	let phase = "setup";
	let workers = () => ({ max: 0 });
	const queried: string[] = [];
	// SAFETY: the settings store calls the pool only as a tagged template; a stored "6" answers.
	const sql = ((..._query: unknown[]) => {
		queried.push(phase);
		return Promise.resolve([{ value: "6" }]);
	}) as unknown as SQL;
	const inner = coding({
		shelfDir,
		model: "a/b",
		worker: { run: async () => "" },
		maxWorkers: 2,
		settingsInDatabase: true,
	});
	const plugin = await testPlugin(
		{
			...inner,
			async setup(context) {
				const contribution = await inner.setup(context);
				const { desk } = context.services.get(CODING);
				workers = () => desk.workers();
				phase = "start";
				return contribution;
			},
		},
		{ database: sql },
	);
	cleanups.push(() => plugin.stop());
	expect(queried).toEqual(["start"]);
	expect(workers().max).toBe(6);
});

describeDb("the worker limit in the host database", () => {
	test("a saved limit wins over maxWorkers at the next setup; none stored keeps the option", async () => {
		const sql = new SQL(testDatabaseUrl);
		cleanups.push(() => sql.close());
		await CODING_SETTINGS_MIGRATION.up(sql);
		await sql`DELETE FROM coding_settings WHERE key = 'max_workers'`;
		cleanups.push(async () => {
			await sql`DELETE FROM coding_settings WHERE key = 'max_workers'`;
		});
		const first = await harness({ maxWorkers: 3, database: sql });
		expect(await first.max()).toBe(3);
		await first.page.act(OWNER, "save", { maxWorkers: "5" });
		const second = await harness({ maxWorkers: 3, database: sql });
		expect(await second.max()).toBe(5);
		await sql`UPDATE coding_settings SET value = '99' WHERE key = 'max_workers'`;
		const third = await harness({ maxWorkers: 3, database: sql });
		expect(await third.max()).toBe(3);
	});
});
