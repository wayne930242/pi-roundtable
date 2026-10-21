import { describe, expect, test } from "bun:test";
import { agentDetails } from "../agents/team-text.ts";
import { serviceKey } from "../contract/services.ts";
import { PluginError } from "../errors.ts";
import type { SkillStore } from "../modules/skills/skill-store.ts";
import { ServiceRegistry } from "../registry/services.ts";
import { MEMORY, SKILLS } from "../services.ts";
import { setUpAddons } from "../testing/modules.ts";
import { skillsPlugin } from "./skills.ts";

describe("the memory addon", () => {
	test("adds the owner-memory session tool and declares its three tools for every speaker", async () => {
		const { memory } = await setUpAddons();
		expect(memory.sessionTools?.map((tool) => tool.name)).toEqual([
			"owner-memory",
		]);
		expect(memory.toolTiers).toEqual({
			memory_add: "member",
			memory_search: "member",
			memory_remove: "member",
		});
	});
});

describe("the skills addon", () => {
	test("adds the skill tools to agent sessions only, offers them to every agent turn, and declares their tiers", async () => {
		const { skills } = await setUpAddons();
		expect(skills.sessionTools?.map((tool) => tool.name)).toEqual([
			"skill-list",
			"skill-tools",
		]);
		expect(skills.agentSelection?.().tools).toEqual([
			"skill_list",
			"skill_link",
			"skill_unlink",
			"skill_create",
			"skill_update",
			"skill_delete",
			"skill_group_set",
			"skill_group_delete",
			"agent_skills",
		]);
		expect(skills.toolTiers).toMatchObject({
			skill_create: "admin",
			agent_skills: "admin",
			skill_list: "member",
		});
	});
});

describe("the skills addon with packages", () => {
	test("stops setup with a PluginError when a package is not installed", async () => {
		const plugin = skillsPlugin(
			{
				guildId: "g1",
				reposDir: "/tmp/repos",
				writtenDir: "/tmp/written",
				builtinDir: "/tmp/builtin",
				packages: ["pi-not-installed"],
			},
			// SAFETY: setup fails on the package before it reads the store.
			async () => ({}) as unknown as SkillStore,
		);
		// SAFETY: setup fails on the package before it reads anything from its context.
		const context = {} as unknown as Parameters<typeof plugin.setup>[0];
		const setUp = async () => plugin.setup(context);
		await expect(setUp()).rejects.toBeInstanceOf(PluginError);
		await expect(setUp()).rejects.toThrow("pi-not-installed");
	});
});

describe("the Discord administration addon", () => {
	test("adds one session tool and keeps every Discord tool with the owner", async () => {
		const { discordAdmin } = await setUpAddons();
		expect(discordAdmin.sessionTools?.map((tool) => tool.name)).toEqual([
			"discord-admin",
		]);
		const tiers = Object.values(discordAdmin.toolTiers ?? {});
		expect(tiers.length).toBeGreaterThan(20);
		expect(new Set(tiers)).toEqual(new Set(["owner"]));
	});
});

describe("a service no plugin provides", () => {
	test("reading memory or skills names the switch that turned the addon off", () => {
		const services = new ServiceRegistry([]);
		expect(() => services.get(MEMORY)).toThrow(
			"service roundtable.memory is not provided. The memory addon is switched off (config memory: false)",
		);
		expect(() => services.get(SKILLS)).toThrow(
			"The skills addon is switched off (config skills: false)",
		);
		expect(services.find(MEMORY)).toBeUndefined();
	});

	test("a key without a hint gets the host's advice", () => {
		expect(() =>
			new ServiceRegistry([]).get(serviceKey<string>("my.thing")),
		).toThrow(
			"service my.thing is not provided. Register a plugin that provides it, before the plugin that reads it.",
		);
	});
});

describe("agent_get while skills are off", () => {
	const agent = {
		name: "scout",
		displayName: "Scout",
		status: "active",
		prompt: "Look.",
		avatarPrompt: "",
	} as Parameters<typeof agentDetails>[0];
	const defaults = { model: "a/b", thinking: "low" } as const;

	test("has no skills line", () => {
		expect(agentDetails(agent, defaults, undefined)).not.toContain("Skills:");
	});

	test("lists what the agent carries when they are on", () => {
		expect(agentDetails(agent, defaults, "writing-skills")).toContain(
			"Skills: writing-skills",
		);
	});
});
