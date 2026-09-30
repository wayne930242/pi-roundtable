import { afterEach, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../db/migrations.ts";
import { SkillStore } from "../modules/skills/skill-store.ts";
import {
	describeDb,
	migratedPool,
	TEST_GUILD,
	testDatabaseUrl,
} from "../testing/database.ts";
import { AgentStore } from "./agent-store.ts";

const OTHER_GUILD = "900000000000000002";
const TABLES = [
	"agents",
	"agent_groups",
	"agent_group_messages",
	"agent_group_cursors",
	"agent_skills",
];

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("guild scoping", () => {
	let sql: SQL;

	beforeEach(async () => {
		const admin = new SQL(testDatabaseUrl);
		for (const table of TABLES)
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		// The tables as they were before rows carried a guild, with rows in every one.
		sql = await migratedPool(AgentStore.migration, SkillStore.migration);
		await sql`INSERT INTO agents (name, display_name, prompt, avatar_prompt, channel_id)
			VALUES ('infra', 'Infra', 'p', 'a', '10'), ('doctor', 'Doctor', 'p', 'a', '11')`;
		await sql`INSERT INTO agent_groups (name, display_name, channel_id, members, host)
			VALUES ('ops', 'Ops', '20', 'infra,doctor', 'infra')`;
		await sql`INSERT INTO agent_group_messages (group_name, author, author_name, text)
			VALUES ('ops', 'owner', 'Riley', 'hi')`;
		await sql`INSERT INTO agent_group_cursors (group_name, agent_name, last_id)
			VALUES ('ops', 'infra', 1)`;
		await sql`INSERT INTO agent_skills (agent, skill) VALUES ('infra', 'ops-skill')`;
	});

	afterEach(async () => {
		await sql.close();
	});

	const upgrade = (guild: string) =>
		migrate(sql, [
			...AgentStore.migrations(guild),
			...SkillStore.migrations(guild),
		]);

	test("existing rows of every table go to the configured guild", async () => {
		await upgrade(TEST_GUILD);
		for (const table of TABLES) {
			const rows: { guild_id: string }[] = await sql.unsafe(
				`SELECT guild_id FROM ${table}`,
			);
			expect(rows.length).toBeGreaterThan(0);
			expect(new Set(rows.map((r) => r.guild_id))).toEqual(
				new Set([TEST_GUILD]),
			);
		}
		const store = await AgentStore.attach(sql, TEST_GUILD);
		expect(store.agents().map((a) => a.name)).toEqual(["infra", "doctor"]);
		expect(store.group("ops")?.members).toEqual(["infra", "doctor"]);
		expect(
			(await store.recentGroupMessages("ops", 5)).map((m) => m.text),
		).toEqual(["hi"]);
		expect((await store.backlog("ops", "doctor", 40)).messages).toHaveLength(1);
		const skills = await SkillStore.attach(sql, TEST_GUILD);
		expect(skills.carriedBy("infra")).toEqual(["ops-skill"]);
	});

	test("running the migration again changes nothing", async () => {
		await upgrade(TEST_GUILD);
		const before = await sql`SELECT * FROM agents ORDER BY name`;
		await upgrade(TEST_GUILD);
		expect(await sql`SELECT * FROM agents ORDER BY name`).toEqual(before);
	});

	test("a guild sees only its own rows and may reuse a name of another", async () => {
		await upgrade(TEST_GUILD);
		const other = await AgentStore.attach(sql, OTHER_GUILD);
		expect(other.agents()).toEqual([]);
		expect(other.groups()).toEqual([]);
		for (const name of ["infra", "doctor"])
			await other.createAgent({
				name,
				displayName: `Other ${name}`,
				prompt: "p",
				avatarPrompt: "a",
				channelId: `3${name.length}`,
			});
		await other.createGroup({
			name: "ops",
			displayName: "Other Ops",
			channelId: "40",
			members: ["infra", "doctor"],
			host: "infra",
		});
		const mine = await AgentStore.attach(sql, TEST_GUILD);
		expect(mine.agent("infra")?.displayName).toBe("Infra");
		const reopened = await AgentStore.attach(sql, OTHER_GUILD);
		expect(reopened.agent("infra")?.displayName).toBe("Other infra");
		expect(reopened.group("ops")?.displayName).toBe("Other Ops");
		// Messages and cursors of one guild's group are not the other's.
		await other.appendGroupMessage("ops", {
			author: "owner",
			authorName: "X",
			text: "elsewhere",
		});
		expect(
			(await mine.recentGroupMessages("ops", 5)).map((m) => m.text),
		).toEqual(["hi"]);
	});

	test("a name is still unique inside its guild", async () => {
		await upgrade(TEST_GUILD);
		const store = await AgentStore.attach(sql, TEST_GUILD);
		expect(() => store.checkNewName("infra")).toThrow(/taken/);
	});
});
