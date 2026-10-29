import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { AgentError } from "../../domain/errors.ts";
import { silentLogger } from "../../log.ts";
import { TEST_GUILD } from "../../testing/database.ts";
import { discoverPackageSkills } from "./package-skills.ts";
import { installPackage, packageDirIn } from "./package-skills-fixture.ts";
import { StoredSkillRegistry } from "./skill-registry.ts";
import {
	hashOf,
	parseSkillDocument,
	SkillConflictError,
	skillFileContent,
} from "./skill-rules.ts";
import { SkillStore } from "./skill-store.ts";

type Row = Record<string, unknown>;

/** Just enough of PostgreSQL for the skills' statements, in memory. */
function fakeDatabase() {
	const skills = new Map<string, Row>();
	const versions: Row[] = [];
	let nextId = 1;
	const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").replace(/\s+/g, " ").trim();
		const v = values;
		await Promise.resolve();
		if (text.startsWith("SELECT * FROM skills")) return [...skills.values()];
		if (text.startsWith("SELECT * FROM skill_groups")) return [];
		if (text.startsWith("SELECT agent, skill FROM agent_skills")) return [];
		if (text.startsWith("INSERT INTO skills (name, kind, repo, path)")) {
			skills.set(String(v[0]), {
				name: v[0],
				kind: "linked",
				repo: v[1],
				path: v[2],
				description: null,
				body: null,
			});
			return [];
		}
		if (text.startsWith("INSERT INTO skills (name, kind, description, body)")) {
			skills.set(String(v[0]), {
				name: v[0],
				kind: "written",
				repo: null,
				path: null,
				description: v[1],
				body: v[2],
			});
			return [];
		}
		if (text.startsWith("UPDATE skills SET description")) {
			const row = skills.get(String(v[2]));
			if (row) Object.assign(row, { description: v[0], body: v[1] });
			return [];
		}
		if (text.startsWith("INSERT INTO skill_versions")) {
			versions.push({
				id: nextId++,
				name: v[0],
				description: v[1],
				body: v[2],
				by_name: v[3],
				at: new Date(),
			});
			return [];
		}
		if (
			text.startsWith("DELETE FROM skill_versions WHERE name = ? AND id NOT")
		) {
			const keep = versions
				.filter((row) => row.name === v[0])
				.slice(-Number(v[2]))
				.map((row) => row.id);
			for (let i = versions.length - 1; i >= 0; i--)
				if (versions[i]?.name === v[0] && !keep.includes(versions[i]?.id))
					versions.splice(i, 1);
			return [];
		}
		if (text.startsWith("DELETE FROM skill_versions")) {
			for (let i = versions.length - 1; i >= 0; i--)
				if (versions[i]?.name === v[0]) versions.splice(i, 1);
			return [];
		}
		if (text.startsWith("DELETE FROM skills")) {
			skills.delete(String(v[0]));
			return [];
		}
		if (text.startsWith("DELETE FROM agent_skills")) return [];
		if (text.startsWith("SELECT id, description, body, by_name, at FROM")) {
			return versions
				.filter((row) => row.name === v[0])
				.reverse()
				.slice(0, Number(v[1]));
		}
		throw new Error(`the fake does not know: ${text}`);
	};
	const sql = Object.assign(run, {
		begin: (body: (tx: typeof run) => Promise<unknown>) => body(run),
	}) as unknown as SQL;
	return { sql, versions };
}

const DESCRIPTION = "Use when reviewing a draft.";
const TEXT = `---\nname: review-draft\ndescription: ${JSON.stringify(DESCRIPTION)}\n---\n\n# Review a draft\n\nRead it twice.\n`;

describe("a SKILL.md the owner edits", () => {
	let dir: string;
	let db: ReturnType<typeof fakeDatabase>;
	let registry: StoredSkillRegistry;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "roundtable-skill-documents-"));
		mkdirSync(join(dir, "builtin/writing-skills"), { recursive: true });
		writeFileSync(
			join(dir, "builtin/writing-skills/SKILL.md"),
			"---\nname: writing-skills\ndescription: Use when writing a skill.\n---\n\nShort.\n",
		);
		mkdirSync(join(dir, "repos/acme/kit/.git"), { recursive: true });
		mkdirSync(join(dir, "repos/acme/kit/skills/kit-do"), { recursive: true });
		writeFileSync(
			join(dir, "repos/acme/kit/skills/kit-do/SKILL.md"),
			"---\nname: kit-do\ndescription: Use when changing source.\n---\n\nDo.\n",
		);
		installPackage(dir, "pkg-skills", {
			"from-package": "Use when a package says so.",
		});
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	async function open() {
		db = fakeDatabase();
		const store = await SkillStore.attach(db.sql, TEST_GUILD);
		registry = new StoredSkillRegistry({
			store,
			reposDir: join(dir, "repos"),
			writtenDir: join(dir, "written"),
			builtinDir: join(dir, "builtin"),
			packageSkills: discoverPackageSkills(["pkg-skills"], packageDirIn(dir)),
			logger: silentLogger(),
		});
		registry.init();
		await registry.link("acme/kit", "skills");
	}

	test("creating from a SKILL.md registers the skill and keeps its first version", async () => {
		await open();
		const made = await registry.createDocument(TEXT, "Riley");
		expect(made).toMatchObject({
			name: "review-draft",
			source: { kind: "written" },
			writable: true,
		});
		expect(made.hash).toBe(hashOf(made.text));
		expect(made.text).toBe(
			skillFileContent({
				name: "review-draft",
				description: DESCRIPTION,
				body: "# Review a draft\n\nRead it twice.",
			}),
		);
		const history = await registry.documentHistory("review-draft");
		expect(history.map((v) => [v.by, v.hash])).toEqual([["Riley", made.hash]]);
	});

	test("a save made from the current hash is written, kept as a version, and read back", async () => {
		await open();
		const made = await registry.createDocument(TEXT, "Riley");
		const edited = made.text.replace("Read it twice.", "Read it three times.");
		const saved = await registry.saveDocument(
			"review-draft",
			edited,
			made.hash,
			"Sam",
		);
		expect(saved.text).toContain("Read it three times.");
		expect(saved.hash).not.toBe(made.hash);
		expect((await registry.document("review-draft")).text).toBe(saved.text);
		const history = await registry.documentHistory("review-draft");
		expect(history.map((v) => v.by)).toEqual(["Sam", "Riley"]);
		expect(history[1]?.text).toBe(made.text);
	});

	test("a save from an older hash is a conflict that carries what is there now", async () => {
		await open();
		const made = await registry.createDocument(TEXT, "Riley");
		const first = await registry.saveDocument(
			"review-draft",
			made.text.replace("twice", "once"),
			made.hash,
			"Sam",
		);
		const error = await registry
			.saveDocument(
				"review-draft",
				made.text.replace("twice", "never"),
				made.hash,
				"Riley",
			)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SkillConflictError);
		expect((error as SkillConflictError).current.hash).toBe(first.hash);
		expect((error as SkillConflictError).current.text).toContain("once");
		expect((await registry.document("review-draft")).hash).toBe(first.hash);
	});

	test("two saves from one hash write one and conflict the other", async () => {
		await open();
		const made = await registry.createDocument(TEXT, "Riley");
		const results = await Promise.allSettled([
			registry.saveDocument(
				"review-draft",
				made.text.replace("twice", "once"),
				made.hash,
				"Riley",
			),
			registry.saveDocument(
				"review-draft",
				made.text.replace("twice", "never"),
				made.hash,
				"Sam",
			),
		]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
			SkillConflictError,
		);
	});

	test("saving the same content writes no new version", async () => {
		await open();
		const made = await registry.createDocument(TEXT, "Riley");
		const again = await registry.saveDocument(
			"review-draft",
			made.text,
			made.hash,
			"Sam",
		);
		expect(again.hash).toBe(made.hash);
		expect(await registry.documentHistory("review-draft")).toHaveLength(1);
	});

	test("built-in, package and linked skills are read-only, and a save to one is refused", async () => {
		await open();
		for (const [name, kind] of [
			["writing-skills", "builtin"],
			["from-package", "package"],
			["kit-do", "linked"],
		] as const) {
			const document = await registry.document(name);
			expect(document.writable).toBe(false);
			expect(document.source.kind).toBe(kind);
			expect(document.text).toContain(`name: ${name}`);
			await expect(
				registry.saveDocument(name, document.text, document.hash, "Riley"),
			).rejects.toThrow(AgentError);
			expect(await registry.documentHistory(name)).toEqual([]);
		}
	});

	test("the frontmatter is checked as the skill tools check it", async () => {
		await open();
		const made = await registry.createDocument(TEXT, "Riley");
		const refused = async (text: string, reason: string) =>
			expect(
				registry.saveDocument("review-draft", text, made.hash, "Riley"),
			).rejects.toThrow(reason);
		await refused("# no frontmatter", "starts with frontmatter");
		await refused(
			made.text.replace(DESCRIPTION, "Reviews drafts"),
			'starts with "Use when"',
		);
		await refused(
			made.text.replace("name: review-draft", "name: other-name"),
			"cannot change",
		);
		await refused(
			made.text.replace("\n---\n\n#", "\nauthor: me\n---\n\n#"),
			'"author"',
		);
		await refused(
			made.text.replace(/\ndescription: .*\n/, "\n"),
			"needs a description",
		);
		await refused(`${made.text}${"x".repeat(12_001)}`, "1 to 12000 characters");
		await refused(
			made.text.replace("---\n\n#", "---\n\n  \n#").replace(/#[\s\S]*$/, ""),
			"1 to 12000 characters",
		);
		await refused(
			made.text.replace("description:", "description: [broken"),
			"valid YAML",
		);
	});

	test("creating refuses a taken name, a bad name and a built-in's name", async () => {
		await open();
		await registry.createDocument(TEXT, "Riley");
		await expect(registry.createDocument(TEXT, "Riley")).rejects.toThrow(
			"already exists",
		);
		await expect(
			registry.createDocument(
				TEXT.replace("review-draft", "Bad Name"),
				"Riley",
			),
		).rejects.toThrow("not a usable skill name");
		await expect(
			registry.createDocument(
				TEXT.replace("review-draft", "writing-skills"),
				"Riley",
			),
		).rejects.toThrow("already exists");
		await expect(
			registry.createDocument(
				TEXT.replace("review-draft", "from-package"),
				"Riley",
			),
		).rejects.toThrow("already exists");
	});

	test("an unknown skill has no document", async () => {
		await open();
		await expect(registry.document("nope")).rejects.toThrow('no skill "nope"');
		await expect(registry.documentHistory("nope")).rejects.toThrow(AgentError);
	});

	test("the history keeps the newest 50 versions", async () => {
		await open();
		const made = await registry.createDocument(TEXT, "Riley");
		let hash = made.hash;
		for (let i = 0; i < 55; i++) {
			const saved = await registry.saveDocument(
				"review-draft",
				made.text.replace("Read it twice.", `Read it ${i} times.`),
				hash,
				"Riley",
			);
			hash = saved.hash;
		}
		const history = await registry.documentHistory("review-draft");
		expect(history).toHaveLength(50);
		expect(history[0]?.text).toContain("Read it 54 times.");
	});

	test("deleting a skill drops its versions", async () => {
		await open();
		await registry.createDocument(TEXT, "Riley");
		await registry.delete("review-draft");
		expect(db.versions).toEqual([]);
	});
});

describe("parseSkillDocument", () => {
	test("reads name, description and the body without its surrounding blank lines", () => {
		expect(parseSkillDocument(TEXT)).toEqual({
			name: "review-draft",
			description: DESCRIPTION,
			body: "# Review a draft\n\nRead it twice.",
		});
	});

	test("reads a Windows file and a file with a byte-order mark", () => {
		expect(
			parseSkillDocument(`\uFEFF${TEXT.replaceAll("\n", "\r\n")}`).name,
		).toBe("review-draft");
	});
});
