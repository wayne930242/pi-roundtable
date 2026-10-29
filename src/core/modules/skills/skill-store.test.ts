import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { AgentError } from "../../domain/errors.ts";
import {
	describeDb,
	openTestStore,
	TEST_GUILD,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { SkillStore } from "./skill-store.ts";

type Row = Record<string, string | null>;

/**
 * Just enough of PostgreSQL for the store's statements, in memory. Every statement yields
 * before it runs, as a round trip does. `slow(select, insert)` makes later SELECTs and
 * skill INSERTs take that many milliseconds: a SELECT's snapshot is taken when it starts and
 * answered at the end, an INSERT runs at the end.
 */
function fakeDatabase() {
	const skills = new Map<string, Row>();
	const groups = new Map<string, Row>();
	const carried: { agent: string; skill: string }[] = [];
	const latency = { select: 0, insert: 0 };
	const wait = (ms: number) => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());
	const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").replace(/\s+/g, " ").trim();
		const v = values as string[];
		if (text.startsWith("SELECT")) {
			const snapshot = text.includes("FROM skills")
				? [...skills.values()]
				: text.includes("FROM skill_groups")
					? [...groups.values()]
					: carried.map((row) => ({ ...row }));
			await wait(latency.select);
			return snapshot;
		}
		await (text.startsWith("INSERT INTO skills")
			? wait(latency.insert)
			: Promise.resolve());
		if (text.startsWith("INSERT INTO skills (name, kind, repo, path)")) {
			if (skills.has(v[0] ?? ""))
				throw Object.assign(new Error("duplicate key"), { errno: "23505" });
			skills.set(v[0] ?? "", {
				name: v[0] ?? "",
				kind: "linked",
				repo: v[1] ?? "",
				path: v[2] ?? "",
				description: null,
				body: null,
			});
		} else if (text.startsWith("DELETE FROM skill_versions")) {
			// The fake keeps no versions.
		} else if (text.startsWith("DELETE FROM skills")) skills.delete(v[0] ?? "");
		else if (text.startsWith("DELETE FROM agent_skills")) {
			const column = text.includes("skill = ?") ? "skill" : "agent";
			for (let i = carried.length - 1; i >= 0; i--)
				if (carried[i]?.[column] === v[1]) carried.splice(i, 1);
		} else if (text.startsWith("INSERT INTO agent_skills"))
			carried.push({ agent: v[1] ?? "", skill: v[2] ?? "" });
		else if (text.startsWith("INSERT INTO skill_groups"))
			groups.set(v[0] ?? "", {
				name: v[0] ?? "",
				description: v[1] ?? "",
				skills: v[2] ?? "",
			});
		else if (text.startsWith("UPDATE skill_groups")) {
			const group = groups.get(v[1] ?? "");
			if (group) group.skills = v[0] ?? "";
		} else throw new Error(`the fake does not know: ${text}`);
		return [];
	};
	const sql = Object.assign(run, {
		begin: (body: (tx: typeof run) => Promise<unknown>) => body(run),
	}) as unknown as SQL;
	return {
		sql,
		skills,
		carried,
		groups,
		slow(select: number, insert: number) {
			latency.select = select;
			latency.insert = insert;
		},
	};
}

const linked = (name: string) => ({
	name,
	repo: "acme/skills",
	path: `skills/${name}`,
});

describe("SkillStore writes running together", () => {
	test("a link made while a skill is removed stays in the registry", async () => {
		const db = fakeDatabase();
		const store = await SkillStore.attach(db.sql, TEST_GUILD);
		await store.addLinked([linked("reviewing-drafts")]);
		await store.setCarried("blog", ["reviewing-drafts"]);
		await store.setGroup({
			name: "writing",
			description: "Writing.",
			skills: ["reviewing-drafts", "other"],
		});
		// As seen live: the removal's reload read the skills before the link's INSERT committed,
		// then answered after the link had set its entry.
		db.slow(40, 20);
		const removed = store.remove("reviewing-drafts");
		const added = store.addLinked([linked("polishing-prose")]);
		expect(await removed).toEqual({ agents: ["blog"], groups: ["writing"] });
		await added;
		db.slow(0, 0);
		expect(store.skill("polishing-prose")).toBeDefined();
		expect(store.skill("reviewing-drafts")).toBeUndefined();
		expect(store.carriedBy("blog")).toEqual([]);
		expect(store.group("writing")?.skills).toEqual(["other"]);
		const fresh = await SkillStore.attach(db.sql, TEST_GUILD);
		expect(fresh.skills()).toEqual(store.skills());
		expect(fresh.groups()).toEqual(store.groups());
		expect(fresh.carriedBy("blog")).toEqual([]);
	});

	test("a carrying set while its skill is removed does not outlive the skill", async () => {
		const db = fakeDatabase();
		const store = await SkillStore.attach(db.sql, TEST_GUILD);
		await store.addLinked([linked("a"), linked("b")]);
		const removed = store.remove("a");
		const set = store.setCarried("blog", ["b"]);
		await Promise.all([removed, set]);
		expect(store.carriedBy("blog")).toEqual(["b"]);
		expect(db.carried).toEqual([{ agent: "blog", skill: "b" }]);
	});

	test("two links of one name register one and refuse the other as taken", async () => {
		const db = fakeDatabase();
		const store = await SkillStore.attach(db.sql, TEST_GUILD);
		const results = await Promise.allSettled([
			store.addLinked([linked("a")]),
			store.addLinked([linked("a")]),
		]);
		expect(results[0]?.status).toBe("fulfilled");
		const refused = results[1];
		expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
			AgentError,
		);
		expect(store.skills().map((s) => s.name)).toEqual(["a"]);
	});

	test("a row the registry does not hold is refused as already registered", async () => {
		const db = fakeDatabase();
		const store = await SkillStore.attach(db.sql, TEST_GUILD);
		db.skills.set("stray", { name: "stray", kind: "linked" });
		const error = await store.addLinked([linked("stray")]).catch((e) => e);
		expect(error).toBeInstanceOf(AgentError);
		expect((error as Error).message).toBe(
			"Already registered: stray. Nothing was linked.",
		);
	});
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("SkillStore writes running together on PostgreSQL", () => {
	let store: TestStore<SkillStore>;

	beforeEach(async () => {
		await store?.close();
		const admin = new SQL(testDatabaseUrl);
		for (const table of ["skills", "skill_groups", "agent_skills"])
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		store = await openTestStore(SkillStore, TEST_GUILD);
		await store.addLinked([linked("a"), linked("b")]);
		await store.setCarried("blog", ["a", "b"]);
		await store.setGroup({
			name: "writing",
			description: "Writing.",
			skills: ["a", "b"],
		});
	});

	afterAll(async () => {
		await store.close();
	});

	/** The store's view, which a store attached afresh to the same rows must share. */
	const view = (s: SkillStore) => ({
		skills: s.skills(),
		groups: s.groups(),
		blog: s.carriedBy("blog"),
		other: s.carriedBy("other"),
	});

	const agrees = async () => {
		const fresh = await openTestStore(SkillStore, TEST_GUILD);
		expect(view(fresh)).toEqual(view(store));
		await fresh.close();
	};

	test("removing one skill while linking another keeps the new one", async () => {
		await Promise.all([store.remove("a"), store.addLinked([linked("c")])]);
		expect(store.skill("c")).toBeDefined();
		expect(store.skill("a")).toBeUndefined();
		expect(store.carriedBy("blog")).toEqual(["b"]);
		expect(store.group("writing")?.skills).toEqual(["b"]);
		await agrees();
	});

	test("linking first and removing second ends the same", async () => {
		await Promise.all([store.addLinked([linked("c")]), store.remove("a")]);
		expect(store.skills().map((s) => s.name)).toEqual(["b", "c"]);
		await agrees();
	});

	test("carrying and removing together keep carriers and groups consistent", async () => {
		await Promise.all([
			store.setCarried("other", ["a", "b"]),
			store.remove("a"),
			store.setGroup({ name: "more", description: "More.", skills: ["b"] }),
			store.remove("b"),
		]);
		expect(store.skills()).toEqual([]);
		expect(store.carriedBy("blog")).toEqual([]);
		expect(store.carriedBy("other")).toEqual([]);
		expect(store.group("writing")?.skills).toEqual([]);
		expect(store.group("more")?.skills).toEqual([]);
		await agrees();
	});

	test("a link of a name taken meanwhile is refused as already registered", async () => {
		const results = await Promise.allSettled([
			store.addLinked([linked("c")]),
			store.addLinked([linked("c")]),
		]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		await agrees();
	});
});
