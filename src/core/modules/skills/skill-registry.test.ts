import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { SQL } from "bun";
import { AgentError } from "../../domain/errors.ts";
import { PluginError } from "../../errors.ts";
import { silentLogger } from "../../log.ts";
import {
	describeDb,
	openTestStore,
	TEST_GUILD,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { discoverPackageSkills } from "./package-skills.ts";
import { installPackage, packageDirIn } from "./package-skills-fixture.ts";
import { StoredSkillRegistry } from "./skill-registry.ts";
import { SkillStore } from "./skill-store.ts";

const BUILTIN = join(import.meta.dir, "..", "..", "assets", "skills");

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let store: TestStore<SkillStore>;
	let registry: StoredSkillRegistry;
	let dir: string;

	const skillFile = (name: string, description: string) =>
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

	function repoSkill(
		repo: string,
		path: string,
		name: string,
		description = `Use when ${name}.`,
	) {
		mkdirSync(join(dir, "repos", repo, ".git"), { recursive: true });
		mkdirSync(join(dir, "repos", repo, path), { recursive: true });
		writeFileSync(
			join(dir, "repos", repo, path, "SKILL.md"),
			skillFile(name, description),
		);
	}

	const open = async () => {
		store = await openTestStore(SkillStore, TEST_GUILD);
		registry = new StoredSkillRegistry({
			store,
			reposDir: join(dir, "repos"),
			writtenDir: join(dir, "skills"),
			builtinDir: BUILTIN,
			logger: silentLogger(),
		});
		registry.init();
	};

	beforeEach(async () => {
		await store?.close();
		const admin = new SQL(testDatabaseUrl);
		for (const table of [
			"skills",
			"skill_groups",
			"agent_skills",
			"skill_versions",
		])
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "roundtable-skills-"));
		repoSkill("acme/skills", "skills/plan-work", "plan-work");
		repoSkill("acme/skills", "skills/write-tests", "write-tests");
		await open();
	});

	afterAll(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const refuses = async (run: () => Promise<unknown>, text: string) => {
		const error = await run().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(AgentError);
		expect((error as Error).message).toContain(text);
	};

	describe("built-in skill", () => {
		test("every set carries writing-skills from the release, with a trigger-only description", () => {
			const set = registry.resolve([]);
			expect(set.missing).toEqual([]);
			expect(set.skills.map((s) => s.name)).toEqual(["writing-skills"]);
			expect(set.skills[0]?.description.startsWith("Use when")).toBe(true);
		});

		test("it cannot be removed, changed, or taken as a name", async () => {
			await refuses(
				() => registry.attach("notes", [], ["writing-skills"]),
				"built in",
			);
			await refuses(
				() => registry.update("writing-skills", { body: "x" }),
				"built in",
			);
			await refuses(
				() =>
					registry.create({
						name: "writing-skills",
						description: "Use when x.",
						body: "x",
					}),
				"already exists",
			);
		});
	});

	describe("linked skills", () => {
		test("a folder of skills links every child with its own name and description", async () => {
			const text = await registry.link("acme/skills", "skills");
			expect(text).toContain("Linked 2 skills");
			const set = registry.resolve(["plan-work", "write-tests"]);
			expect(set.skills.map((s) => s.name)).toEqual([
				"writing-skills",
				"plan-work",
				"write-tests",
			]);
			expect(set.skills[1]?.file).toBe(
				join(dir, "repos/acme/skills/skills/plan-work/SKILL.md"),
			);
		});

		test("a single skill folder links just that skill", async () => {
			await registry.link("acme/skills", "./skills/plan-work/");
			expect(store.skill("plan-work")).toEqual({
				kind: "linked",
				name: "plan-work",
				repo: "acme/skills",
				path: "skills/plan-work",
			});
			expect(store.skill("write-tests")).toBeUndefined();
		});

		test("a pull that changes the description shows on the next resolve", async () => {
			await registry.link("acme/skills", "skills/plan-work");
			repoSkill(
				"acme/skills",
				"skills/plan-work",
				"plan-work",
				"Use when changed.",
			);
			expect(registry.resolve(["plan-work"]).skills[1]?.description).toBe(
				"Use when changed.",
			);
		});

		test("one taken name refuses the whole call", async () => {
			await registry.link("acme/skills", "skills/plan-work");
			await refuses(
				() => registry.link("acme/skills", "skills"),
				"Nothing was linked",
			);
			expect(store.skill("write-tests")).toBeUndefined();
		});

		test("unmanaged repositories, escaping paths, and folders without skills are refused", async () => {
			await refuses(
				() => registry.link("acme/other", "skills"),
				"not a managed repository",
			);
			await refuses(() => registry.link("acme/skills", "../../x"), "inside");
			mkdirSync(join(dir, "repos/acme/skills/docs"), { recursive: true });
			await refuses(() => registry.link("acme/skills", "docs"), "no SKILL.md");
		});

		test("linked skills are read-only through the skill tools", async () => {
			await registry.link("acme/skills", "skills/plan-work");
			await refuses(
				() => registry.update("plan-work", { body: "x" }),
				"repo_task",
			);
			await refuses(() => registry.delete("plan-work"), "read-only");
		});

		test("a vanished or renamed file is reported missing, not loaded", async () => {
			await registry.link("acme/skills", "skills");
			rmSync(join(dir, "repos/acme/skills/skills/write-tests"), {
				recursive: true,
			});
			repoSkill("acme/skills", "skills/plan-work", "plan-work-renamed");
			const set = registry.resolve(["plan-work", "write-tests"]);
			expect(set.skills.map((s) => s.name)).toEqual(["writing-skills"]);
			expect(set.missing.map((m) => m.name)).toEqual([
				"plan-work",
				"write-tests",
			]);
			expect(set.missing[0]?.reason).toContain("plan-work-renamed");
			expect(registry.list()).toContain("missing: file not found");
		});
	});

	describe("agent-written skills", () => {
		test("create writes a SKILL.md Pi reads back with the same name and description", async () => {
			await registry.create({
				name: "daily-notes",
				description: 'Use when writing a "daily" note: summaries or logs.',
				body: "# Daily notes\n\n1. Write.",
			});
			const file = join(dir, "skills/daily-notes/SKILL.md");
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(
				readFileSync(file, "utf8"),
			);
			expect(frontmatter.name).toBe("daily-notes");
			expect(frontmatter.description).toBe(
				'Use when writing a "daily" note: summaries or logs.',
			);
			expect(body.trim()).toBe("# Daily notes\n\n1. Write.");
			expect(registry.resolve(["daily-notes"]).skills[1]?.file).toBe(file);
		});

		test("descriptions must be triggers, bodies bounded, names Pi-valid", async () => {
			await refuses(
				() =>
					registry.create({
						name: "x",
						description: "Writes notes.",
						body: "b",
					}),
				"Use when",
			);
			await refuses(
				() =>
					registry.create({
						name: "x",
						description: "Use when x.",
						body: "b".repeat(12_001),
					}),
				"12000",
			);
			await refuses(
				() =>
					registry.create({
						name: "Bad--name",
						description: "Use when x.",
						body: "b",
					}),
				"not a usable skill name",
			);
		});

		test("update rewrites the file; delete removes it and detaches carriers and groups", async () => {
			await registry.create({
				name: "daily-notes",
				description: "Use when a.",
				body: "one",
			});
			await registry.update("daily-notes", { body: "two" });
			expect(
				readFileSync(join(dir, "skills/daily-notes/SKILL.md"), "utf8"),
			).toContain("two");
			await registry.attach("notes", ["daily-notes"], []);
			await registry.setGroup("writing", "Writing skills.", [
				"daily-notes",
				"writing-skills",
			]);
			const text = await registry.delete("daily-notes");
			expect(text).toBe(
				"Removed skill daily-notes; detached from agents notes and groups writing.",
			);
			expect(existsSync(join(dir, "skills/daily-notes"))).toBe(false);
			expect(store.carriedBy("notes")).toEqual([]);
			expect(store.group("writing")?.skills).toEqual(["writing-skills"]);
		});

		test("a restart rewrites files from the database and clears stale folders", async () => {
			await registry.create({
				name: "daily-notes",
				description: "Use when a.",
				body: "one",
			});
			rmSync(join(dir, "skills/daily-notes"), { recursive: true });
			mkdirSync(join(dir, "skills/stale"), { recursive: true });
			await store.close();
			await open();
			expect(existsSync(join(dir, "skills/daily-notes/SKILL.md"))).toBe(true);
			expect(existsSync(join(dir, "skills/stale"))).toBe(false);
		});
	});

	describe("documents the owner edits", () => {
		const text = (body: string) =>
			`---\nname: daily-notes\ndescription: "Use when keeping notes."\n---\n\n${body}\n`;

		test("a save is kept as a version that outlives a restart, and deleting the skill drops them", async () => {
			const made = await registry.createDocument(text("One."), "Riley");
			const saved = await registry.saveDocument(
				"daily-notes",
				text("Two."),
				made.hash,
				"Sam",
			);
			await store.close();
			await open();
			const history = await registry.documentHistory("daily-notes");
			expect(history.map((v) => [v.by, v.hash])).toEqual([
				["Sam", saved.hash],
				["Riley", made.hash],
			]);
			expect((await registry.document("daily-notes")).hash).toBe(saved.hash);
			await registry.delete("daily-notes");
			await registry.createDocument(text("Three."), "Riley");
			expect(await registry.documentHistory("daily-notes")).toHaveLength(1);
		});

		test("a linked skill's document is its file, and is read-only", async () => {
			await registry.link("acme/skills", "skills/plan-work");
			const document = await registry.document("plan-work");
			expect(document.writable).toBe(false);
			expect(document.source).toEqual({
				kind: "linked",
				repo: "acme/skills",
				path: "skills/plan-work",
			});
			expect(document.text).toContain("name: plan-work");
		});
	});

	describe("groups and carrying", () => {
		test("attach adds and removes together and survives a restart", async () => {
			await registry.link("acme/skills", "skills");
			expect(
				await registry.attach("infra", ["plan-work", "write-tests"], []),
			).toEqual(["plan-work", "write-tests"]);
			expect(await registry.attach("infra", [], ["write-tests"])).toEqual([
				"plan-work",
			]);
			await store.close();
			await open();
			expect(store.carriedBy("infra")).toEqual(["plan-work"]);
			expect(registry.describeCarried("infra")).toBe(
				"writing-skills (built in), plan-work",
			);
		});

		test("an unknown name changes nothing", async () => {
			await registry.link("acme/skills", "skills");
			await refuses(
				() => registry.attach("infra", ["plan-work", "nope"], []),
				"Unknown skills: nope",
			);
			expect(store.carriedBy("infra")).toEqual([]);
		});

		test("the catalog lists every skill with its source, groups, carriers, and missing files", async () => {
			await registry.link("acme/skills", "skills");
			await registry.setGroup("coding", "Coding workflow.", ["plan-work"]);
			await registry.attach("infra", ["plan-work"], []);
			rmSync(join(dir, "repos", "acme/skills", "skills/write-tests"), {
				recursive: true,
			});
			const catalog = registry.catalog();
			expect(catalog.map((entry) => entry.name)).toEqual([
				"writing-skills",
				"plan-work",
				"write-tests",
			]);
			expect(catalog[0]).toMatchObject({
				source: { kind: "builtin" },
				file: join(BUILTIN, "writing-skills", "SKILL.md"),
			});
			expect(catalog[1]).toEqual({
				name: "plan-work",
				source: {
					kind: "linked",
					repo: "acme/skills",
					path: "skills/plan-work",
				},
				description: "Use when plan-work.",
				file: join(dir, "repos", "acme/skills", "skills/plan-work", "SKILL.md"),
				groups: ["coding"],
				carriers: ["infra"],
			});
			expect(catalog[2]?.missing).toBeString();
			expect(catalog[2]?.file).toBeUndefined();
		});

		test("groups filter the list; unlinking detaches from groups too", async () => {
			await registry.link("acme/skills", "skills");
			await registry.setGroup("coding", "Coding workflow.", ["plan-work"]);
			await registry.attach("infra", ["plan-work"], []);
			const listed = registry.list({ group: "coding" });
			expect(listed).toContain(
				"- plan-work [linked from acme/skills:skills/plan-work]",
			);
			expect(listed).toContain("carried by: infra");
			expect(listed).not.toContain("- write-tests");
			expect(registry.list({ query: "write-tests" })).toContain(
				"- write-tests",
			);
			expect(await registry.unlink("plan-work")).toBe(
				"Removed skill plan-work; detached from agents infra and groups coding.",
			);
			await refuses(
				() => registry.setGroup("coding", "x", ["nope"]),
				"Unknown skills",
			);
			await refuses(
				async () => registry.list({ group: "nope" }),
				"no skill group",
			);
		});

		test("groups lists each group with its skills, and a deleted group leaves its skills carried", async () => {
			await registry.link("acme/skills", "skills");
			expect(
				await registry.setGroup("coding", " Coding workflow. ", [
					"plan-work",
					"write-tests",
				]),
			).toBe("Created skill group coding: plan-work, write-tests.");
			await registry.attach("infra", ["plan-work"], []);
			expect(registry.groups()).toEqual([
				{
					name: "coding",
					description: "Coding workflow.",
					skills: ["plan-work", "write-tests"],
				},
			]);
			registry.groups()[0]?.skills.push("mutated");
			expect(registry.groups()[0]?.skills).toEqual([
				"plan-work",
				"write-tests",
			]);
			await refuses(
				() => registry.setGroup("coding", " ", []),
				"needs a description",
			);
			expect(await registry.deleteGroup("coding")).toBe(
				"Deleted skill group coding; its skills are untouched.",
			);
			expect(registry.groups()).toEqual([]);
			expect(store.carriedBy("infra")).toEqual(["plan-work"]);
			await refuses(() => registry.deleteGroup("coding"), "no skill group");
		});
	});

	describe("package skills", () => {
		const reopen = (packages: string[]) => {
			registry = new StoredSkillRegistry({
				store,
				reposDir: join(dir, "repos"),
				writtenDir: join(dir, "skills"),
				builtinDir: BUILTIN,
				packageSkills: discoverPackageSkills(packages, packageDirIn(dir)),
				logger: silentLogger(),
			});
			registry.init();
		};

		beforeEach(() => {
			installPackage(dir, "pi-workflow-skills", {
				coding: "Use when changing code.",
				grilling: "Use when deciding.",
			});
			reopen(["pi-workflow-skills"]);
		});

		test("are offered next to the others, with the package as source and no database row", () => {
			expect(registry.catalog().map((c) => [c.name, c.source.kind])).toEqual([
				["writing-skills", "builtin"],
				["coding", "package"],
				["grilling", "package"],
			]);
			expect(registry.catalog()[1]).toMatchObject({
				name: "coding",
				source: { kind: "package", package: "pi-workflow-skills" },
				description: "Use when changing code.",
				file: join(
					dir,
					"node_modules/pi-workflow-skills/skills/coding/SKILL.md",
				),
			});
			expect(store.skill("coding")).toBeUndefined();
			expect(registry.list()).toContain(
				"- coding [from the package pi-workflow-skills]",
			);
		});

		test("an agent carries them, a group holds them, and they resolve to the installed file", async () => {
			await registry.attach("infra", ["coding", "grilling"], []);
			await registry.setGroup("workflow", "Workflow skills.", ["coding"]);
			expect(registry.carriedNames("infra")).toEqual(["coding", "grilling"]);
			expect(registry.describeCarried("infra")).toBe(
				"writing-skills (built in), coding, grilling",
			);
			const set = registry.carried("infra");
			expect(set.missing).toEqual([]);
			expect(set.skills.map((skill) => skill.name)).toEqual([
				"writing-skills",
				"coding",
				"grilling",
			]);
			expect(set.skills[1]?.file).toBe(
				join(dir, "node_modules/pi-workflow-skills/skills/coding/SKILL.md"),
			);
			expect(registry.list({ group: "workflow" })).toContain("- coding");
			expect(registry.catalog()[1]).toMatchObject({
				groups: ["workflow"],
				carriers: ["infra"],
			});
		});

		test("a package upgrade changes the skill with no database write", async () => {
			await registry.attach("infra", ["coding"], []);
			installPackage(dir, "pi-workflow-skills", {
				coding: "Use when upgraded.",
				grilling: "Use when deciding.",
			});
			expect(registry.carried("infra").skills[1]?.description).toBe(
				"Use when upgraded.",
			);
		});

		test("cannot be unlinked, updated, or deleted", async () => {
			for (const run of [
				() => registry.unlink("coding"),
				() => registry.update("coding", { body: "x" }),
				() => registry.delete("coding"),
			])
				await refuses(run, "comes from the package pi-workflow-skills");
		});

		test("hold their name against linking and creating", async () => {
			await refuses(
				() =>
					registry.create({
						name: "coding",
						description: "Use when x.",
						body: "x",
					}),
				"comes from the package pi-workflow-skills",
			);
			repoSkill("acme/skills", "skills/coding", "coding");
			await refuses(
				() => registry.link("acme/skills", "skills/coding"),
				"comes from the package pi-workflow-skills",
			);
			expect(store.skill("coding")).toBeUndefined();
		});

		test("a skill gone after an upgrade is reported missing and skipped, like a vanished linked one", async () => {
			await registry.attach("infra", ["coding", "grilling"], []);
			rmSync(join(dir, "node_modules/pi-workflow-skills/skills/grilling"), {
				recursive: true,
			});
			const set = registry.carried("infra");
			expect(set.skills.map((skill) => skill.name)).toEqual([
				"writing-skills",
				"coding",
			]);
			expect(set.missing).toEqual([
				{ name: "grilling", reason: "file not found" },
			]);
			reopen([]);
			expect(registry.carried("infra").missing.map((m) => m.name)).toEqual([
				"coding",
				"grilling",
			]);
			expect(registry.describeCarried("infra")).toContain(
				"coding (missing: not registered)",
			);
		});

		test("a linked or written skill with a package skill's name stops startup", async () => {
			await registry.attach("infra", [], []);
			repoSkill("acme/skills", "skills/other", "other");
			await registry.link("acme/skills", "skills/other");
			await registry.create({
				name: "memo",
				description: "Use when memo.",
				body: "memo",
			});
			for (const clashing of ["other", "memo"]) {
				const name = `pi-clash-${clashing}`;
				installPackage(dir, name, { [clashing]: "Use when x." });
				expect(() => reopen([name])).toThrow(PluginError);
				expect(() => reopen([name])).toThrow(
					`The skill "${clashing}" of the package "${name}" clashes`,
				);
			}
		});
	});
});
