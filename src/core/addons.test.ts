import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SQL } from "bun";
import type { DiscordAgentTeam } from "./agents/agent-team.ts";
import { AgentError } from "./domain/errors.ts";
import { PluginError } from "./errors.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import { AGENTS, MEMORY, SKILLS } from "./services.ts";
import { describeDb, testDatabaseUrl } from "./testing/database.ts";
import { hasWebAccess, type TestHost, testHost } from "./testing/test-host.ts";
import { captureToolSet, scout, type ToolSet } from "./testing/tool-set.ts";

let running: TestHost | undefined;
afterEach(async () => {
	await running?.stop();
	running = undefined;
});

/** Every tool any of the three sessions offers or selects. */
function allTools(set: ToolSet): string[] {
	return Object.values(set.sessions).flatMap((session) => [
		...session.tools,
		...(session.selection ?? []),
	]);
}

const SKILL_NAMES = [
	"skill_link",
	"skill_unlink",
	"skill_create",
	"skill_update",
	"skill_delete",
	"skill_group_set",
	"skill_group_delete",
	"agent_skills",
];
const MEMORY_NAMES = ["memory_add", "memory_search", "memory_remove"];

/** A plugin that notes what the addon services look like to a later plugin. */
function reader(seen: Record<string, unknown>): RoundtablePlugin {
	return {
		name: "reader",
		setup: ({ services }) => {
			seen.skills = services.find(SKILLS);
			seen.memory = services.find(MEMORY);
			return { services: [{ name: "reader" }] };
		},
	};
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describe.skip)("an addon switched off", () => {
	test("skills: false removes the skill tools, leaves agents carrying none, and refuses agent_create with skills", async () => {
		const seen: Record<string, unknown> = {};
		const host = await testHost({
			config: { skills: false },
			plugins: [reader(seen)],
		});
		running = host;
		expect(seen.skills).toBeUndefined();
		expect(seen.memory).toBeDefined();
		const tools = allTools(await captureToolSet(host));
		for (const name of SKILL_NAMES) expect(tools).not.toContain(name);
		// Everything else stays: the agent tools, memory, and the Discord tools.
		expect(tools).toContain("agent_create");
		expect(tools).toContain("memory_add");
		expect(tools).toContain("discord_send_message");

		// SAFETY: the concrete team has the methods the agent tools call; no port publishes them.
		const team = host.context.services.get(AGENTS)
			.team as unknown as DiscordAgentTeam;
		expect(team.skillsOf("scout")).toEqual([]);
		const request = {
			name: "newcomer",
			displayName: "Newcomer",
			prompt: "Help.",
			avatarPrompt: "A helper",
			task: "Say hello.",
			skills: ["writing-skills"],
		};
		const refusal = await team.create(scout, request).catch((e: unknown) => e);
		expect(refusal).toBeInstanceOf(AgentError);
		expect((refusal as Error).message).toContain("Skills are off");

		// The tool no longer offers the parameter.
		const params = new Map<string, string[]>();
		await team.extension(scout)({
			registerTool: (tool: {
				name: string;
				parameters: { properties?: Record<string, unknown> };
			}) =>
				params.set(tool.name, Object.keys(tool.parameters.properties ?? {})),
			on: () => undefined,
		} as unknown as ExtensionAPI);
		expect(params.get("agent_create")).not.toContain("skills");
	});

	test("memory: false removes the memory tools, and a plugin that needs the store fails at setup saying so", async () => {
		const seen: Record<string, unknown> = {};
		const host = await testHost({
			config: { memory: false },
			plugins: [reader(seen)],
		});
		running = host;
		expect(seen.memory).toBeUndefined();
		const tools = allTools(await captureToolSet(host));
		for (const name of MEMORY_NAMES) expect(tools).not.toContain(name);
		expect(tools).toContain("skill_create");
		await host.stop();
		running = undefined;

		const needy: RoundtablePlugin = {
			name: "needy",
			setup: ({ services }) => {
				services.get(MEMORY);
				return { services: [{ name: "needy" }] };
			},
		};
		const failure = await testHost({
			config: { memory: false },
			plugins: [needy],
		}).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(PluginError);
		expect((failure as Error).message).toContain(
			"service roundtable.memory is not provided. The memory addon is switched off (config memory: false)",
		);
	});

	test("discord.admin: false removes the Discord tools", async () => {
		const host = await testHost({
			config: { discord: { ...quietDiscordConfig(), admin: false } },
		});
		running = host;
		const tools = allTools(await captureToolSet(host));
		expect(tools.filter((name) => name.startsWith("discord_"))).toEqual([]);
		expect(tools).toContain("memory_add");
		expect(tools).toContain("skill_create");
	});

	test("switching the addons off leaves their tables and rows as they were", async () => {
		const sql = new SQL(testDatabaseUrl, { max: 2 });
		const marks = {
			memory: "addon-off-test fact",
			skill: "addon-off-test-skill",
		};
		try {
			// A first boot with the defaults creates the tables; put a row in each.
			const first = await testHost();
			await first.context.services
				.get(MEMORY)
				.forSpeaker("100000000000000001")
				.add(marks.memory, "note");
			await sql`INSERT INTO skills (name, kind, description, body)
				VALUES (${marks.skill}, 'written', 'Test.', 'Body.')
				ON CONFLICT (name) DO NOTHING`;
			await first.stop();

			const off = await testHost({
				config: {
					skills: false,
					memory: false,
					discord: { ...quietDiscordConfig(), admin: false },
				},
			});
			await off.stop();

			const facts =
				await sql`SELECT fact FROM owner_memory WHERE fact = ${marks.memory}`;
			const skills =
				await sql`SELECT name FROM skills WHERE name = ${marks.skill}`;
			expect(facts.length).toBe(1);
			expect(skills.length).toBe(1);
		} finally {
			await sql`DELETE FROM owner_memory WHERE fact = ${marks.memory}`;
			await sql`DELETE FROM skills WHERE name = ${marks.skill}`;
			await sql.close();
		}
	});
});

/** The configuration's Discord block, to switch one key of it. */
function quietDiscordConfig() {
	return {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	};
}
