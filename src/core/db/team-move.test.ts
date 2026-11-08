import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { agentMigrations } from "../agents/agent-schema.ts";
import { describeDb, migratedPool } from "../testing/database.ts";
import { moveTeam } from "./team-move.ts";

const FORMER = "900000000000000777";
const OTHER = "900000000000000888";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("moveTeam", () => {
	let sql: SQL;

	const insertAgent = (guild: string, name: string, channel: string | null) =>
		sql`INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id)
			VALUES (${guild}, ${name}, ${name}, '', '', ${channel})`;
	const namesOf = async (guild: string) =>
		(
			(await sql`SELECT name FROM agents WHERE guild_id = ${guild} ORDER BY name`) as {
				name: string;
			}[]
		).map((row) => row.name);

	beforeEach(async () => {
		sql?.close();
		const admin = await migratedPool();
		for (const table of [
			"agents",
			"agent_groups",
			"agent_group_messages",
			"agent_group_cursors",
			"discord_grants",
		])
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		sql = await migratedPool(...agentMigrations("local"));
		await sql.unsafe(
			"CREATE TABLE discord_grants (guild_id text NOT NULL, who text NOT NULL, PRIMARY KEY (guild_id, who))",
		);
		await sql`INSERT INTO discord_grants VALUES (${FORMER}, 'a')`;
		await insertAgent(FORMER, "moved", "100");
		await insertAgent(FORMER, "both", "101");
		await insertAgent("local", "both", null);
		await insertAgent(OTHER, "elsewhere", "102");
		await sql`INSERT INTO agent_groups (guild_id, name, display_name, channel_id, members, host)
			VALUES (${FORMER}, 'council', 'Council', '200', 'moved', 'moved')`;
	});

	afterAll(async () => {
		if (sql) {
			for (const table of [
				"agents",
				"agent_groups",
				"agent_group_messages",
				"agent_group_cursors",
				"discord_grants",
			])
				await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
			await sql.close();
		}
	});

	test("moves a former team's rows to the team id and leaves other guilds' rows", async () => {
		await moveTeam({ from: [FORMER], to: "local" }).up(sql);
		expect(await namesOf("local")).toEqual(["both", "moved"]);
		expect(await namesOf(FORMER)).toEqual(["both"]);
		expect(await namesOf(OTHER)).toEqual(["elsewhere"]);
		const groups =
			await sql`SELECT guild_id FROM agent_groups WHERE name = 'council'`;
		expect(groups[0].guild_id).toBe("local");
		const grants = await sql`SELECT guild_id FROM discord_grants`;
		expect(grants[0].guild_id).toBe(FORMER);
	});

	test("a second run changes nothing", async () => {
		const migration = moveTeam({ from: [FORMER], to: "local" });
		await migration.up(sql);
		await sql`UPDATE agents SET channel_id = '300' WHERE name = 'moved'`;
		await migration.up(sql);
		const [moved] =
			await sql`SELECT channel_id FROM agents WHERE name = 'moved'`;
		expect(moved.channel_id).toBe("300");
		expect(await namesOf("local")).toEqual(["both", "moved"]);
	});

	test("clears the channel ids of the rows it moved when the team has no Discord channels", async () => {
		await moveTeam({ from: [FORMER], to: "local", clearChannels: true }).up(
			sql,
		);
		const rows =
			await sql`SELECT name, channel_id FROM agents ORDER BY name, guild_id`;
		expect(
			rows.map((r: { name: string; channel_id: string | null }) => [
				r.name,
				r.channel_id,
			]),
		).toEqual([
			["both", "101"],
			["both", null],
			["elsewhere", "102"],
			["moved", null],
		]);
		const [group] =
			await sql`SELECT channel_id FROM agent_groups WHERE name = 'council'`;
		expect(group.channel_id).toBeNull();
	});

	test("a team with Discord clears the channel ids of rows from a former id that is not its guild", async () => {
		await insertAgent(OTHER, "from-other", "103");
		await moveTeam({
			from: [FORMER, OTHER],
			to: "local",
			discordGuild: OTHER,
		}).up(sql);
		const rows = await sql`SELECT name, channel_id FROM agents
			WHERE guild_id = 'local' ORDER BY name`;
		expect(
			rows.map((r: { name: string; channel_id: string | null }) => [
				r.name,
				r.channel_id,
			]),
		).toEqual([
			["both", null],
			["elsewhere", "102"],
			["from-other", "103"],
			["moved", null],
		]);
	});

	test("a team without Discord channels also clears the channel ids its own rows hold, moved or not", async () => {
		await sql`UPDATE agents SET channel_id = '555' WHERE guild_id = 'local'`;
		await moveTeam({ from: [], to: "local", clearChannels: true }).up(sql);
		const [own] =
			await sql`SELECT channel_id FROM agents WHERE guild_id = 'local'`;
		expect(own.channel_id).toBeNull();
		const [other] =
			await sql`SELECT channel_id FROM agents WHERE guild_id = ${OTHER}`;
		expect(other.channel_id).toBe("102");
	});

	test("two former ids that hold the same key: the first listed wins, the boot does not fail", async () => {
		await insertAgent(OTHER, "moved", "104");
		await moveTeam({ from: [OTHER, FORMER], to: "local" }).up(sql);
		const [row] = await sql`SELECT channel_id FROM agents
			WHERE guild_id = 'local' AND name = 'moved'`;
		expect(row.channel_id).toBe("104");
		expect(await namesOf(FORMER)).toEqual(["both", "moved"]);
	});

	test("warns, naming the rows that stay under a former id", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await moveTeam({ from: [FORMER], to: "local" }).up(sql);
			expect(warn).toHaveBeenCalled();
			const text = warn.mock.calls.map((call) => call.join(" ")).join("\n");
			expect(text).toContain("agents");
			expect(text).toContain("both");
		} finally {
			warn.mockRestore();
		}
	});

	test("moves nothing when the former id is the team id", async () => {
		await moveTeam({ from: ["local"], to: "local", clearChannels: true }).up(
			sql,
		);
		expect(await namesOf("local")).toEqual(["both"]);
	});
});

test("names the migration and runs it at every boot", () => {
	const migration = moveTeam({ from: [FORMER], to: "local" });
	expect(migration.name).toBe("team-move");
	expect(migration.runs).toBe("every-boot");
});
