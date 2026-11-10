import { afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { PgAgentStore } from "../agents/agent-store.ts";
import { LEGACY_CHANNEL_SURFACE } from "../db/legacy-channels.ts";
import { migrate } from "../db/migrations.ts";
import { describeDb, migratedPool } from "../testing/database.ts";
import { type AgentServerOptions, agentServerPlugin } from "./agent-server.ts";

const GUILD = "900000000000000301";
const TEAM = "moved-team";

/** Only the fields the plugin reads while it declares its migrations. */
const serverOptions = (extra: Partial<AgentServerOptions>) =>
	({
		guildId: GUILD,
		coordinator: "guide",
		...extra,
	}) as AgentServerOptions;

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("agent server: places across a team move", () => {
	let sql: SQL;
	afterAll(async () => {
		if (!sql) return;
		for (const table of ["agent_places", "agents", "agent_groups"])
			await sql.unsafe(`DELETE FROM ${table}`);
		await sql.close();
	});

	test("rows moved in from the former id with their channel ids get their places at that first boot", async () => {
		sql = await migratedPool();
		const boot = async (extra: Partial<AgentServerOptions>) =>
			migrate(sql, agentServerPlugin(serverOptions(extra)).migrations ?? []);
		await boot({ teamId: GUILD });
		await sql`INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id)
			VALUES (${GUILD}, 'infra', 'infra', 'p', '', '10')`;
		// A 0.43 host wrote the column only: the former id's rows have no place rows.
		await sql`DELETE FROM agent_places`;
		await boot({ teamId: TEAM, formerTeamIds: [GUILD] });
		const rows =
			await sql`SELECT team_id, name, external_id FROM agent_places WHERE surface = ${LEGACY_CHANNEL_SURFACE}`;
		expect([...rows]).toEqual([
			{ team_id: TEAM, name: "infra", external_id: "10" },
		]);
		const store = await PgAgentStore.attach(sql, TEAM);
		expect(store.places.ownerOf(LEGACY_CHANNEL_SURFACE, "10")).toEqual({
			kind: "agent",
			name: "infra",
		});
	});

	test("the places of any placeSpaces surface follow their space: moved from the team's own space they stay, from another's they are dropped", async () => {
		sql = await migratedPool();
		await sql.unsafe("DELETE FROM agent_places");
		const boot = async (extra: Partial<AgentServerOptions>) =>
			migrate(sql, agentServerPlugin(serverOptions(extra)).migrations ?? []);
		await boot({ teamId: "pager-home" });
		for (const [team, name, id] of [
			["book-1", "infra", "pg-1"],
			["book-0", "doctor", "pg-2"],
		] as const)
			await sql`INSERT INTO agent_places (team_id, kind, name, surface, external_id)
				VALUES (${team}, 'agent', ${name}, 'pager', ${id})`;
		await boot({
			teamId: "pager-home",
			formerTeamIds: ["book-0", "book-1"],
			placeSpaces: [{ surface: "pager", space: "book-1" }],
		});
		const rows =
			await sql`SELECT team_id, name, external_id FROM agent_places WHERE surface = 'pager' ORDER BY name`;
		expect([...rows]).toEqual([
			{ team_id: "pager-home", name: "infra", external_id: "pg-1" },
		]);
	});
});
