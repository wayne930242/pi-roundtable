import { describe, expect, test } from "bun:test";
import { ConfigError } from "./domain/errors.ts";
import {
	CORE_TOOL_TIERS,
	parseToolTiers,
	toolsForTier,
	toolTiers,
} from "./tool-tiers.ts";

describe("default tiers", () => {
	const tiers = toolTiers();

	test("members may look, read, and message agents", () => {
		for (const tool of [
			"agent_list",
			"agent_get",
			"message_agent",
			"channel_read",
			"ask_user",
			"web_search",
		])
			expect(tiers.minTier(tool)).toBe("member");
	});

	test("every speaker may keep a memory of their own", () => {
		for (const tool of ["memory_add", "memory_search", "memory_remove"])
			expect(tiers.minTier(tool)).toBe("member");
	});

	test("creating, editing, archiving, and arranging agents and groups need an admin", () => {
		for (const tool of [
			"agent_create",
			"agent_update",
			"agent_avatar",
			"group_create",
			"group_update",
			"archive",
			"channel_arrange",
			"agent_skills",
			"schedule_create",
			"delegate_task",
		])
			expect(tiers.minTier(tool)).toBe("admin");
	});

	test("the shell, notifying the owner, Discord administration, and any tool nobody named stay with the owner", () => {
		for (const tool of [
			"bash",
			"write",
			"notify_owner",
			"discord_ban",
			"some_plugin_tool",
		])
			expect(tiers.minTier(tool)).toBe("owner");
	});

	test("every tool an agent carries from the core is named on purpose", () => {
		expect(Object.keys(CORE_TOOL_TIERS)).toEqual(
			expect.arrayContaining(["agent_create", "skill_create", "schedule_list"]),
		);
	});
});

describe("toolsForTier", () => {
	const tiers = toolTiers();
	const all = ["agent_list", "agent_create", "bash", "some_plugin_tool"];

	test("each tier gets the tools at or below it, in order", () => {
		expect(toolsForTier(all, "member", tiers)).toEqual(["agent_list"]);
		expect(toolsForTier(all, "admin", tiers)).toEqual([
			"agent_list",
			"agent_create",
		]);
		expect(toolsForTier(all, "owner", tiers)).toEqual(all);
	});

	test("an operator's map lowers or raises a tool", () => {
		const custom = toolTiers({ bash: "admin", agent_list: "owner" });
		expect(toolsForTier(all, "member", custom)).toEqual([]);
		expect(toolsForTier(all, "admin", custom)).toEqual([
			"agent_create",
			"bash",
		]);
	});

	test("a plugin's declared tier is read at use time; the operator's still wins", () => {
		const table = toolTiers({ plugin_b: "owner" });
		expect(table.minTier("plugin_a")).toBe("owner");
		table.declare("a", { plugin_a: "member" });
		table.declare("b", { plugin_b: "member" });
		expect(table.minTier("plugin_a")).toBe("member");
		expect(table.minTier("plugin_b")).toBe("owner");
	});

	test("a tool two plugins declare names both plugins and the fix", () => {
		const table = toolTiers();
		table.declare("a", { shared_tool: "member" });
		expect(() => table.declare("b", { shared_tool: "member" })).toThrow(
			"plugin b: tool shared_tool is already defined by plugin a. Rename one of the two tools.",
		);
	});
});

describe("parseToolTiers", () => {
	test("reads tool=tier pairs", () => {
		expect(parseToolTiers("bash=admin, web_search=member", "X")).toEqual({
			bash: "admin",
			web_search: "member",
		});
		expect(parseToolTiers(undefined, "X")).toEqual({});
	});

	test("refuses a pair that is not a tier", () => {
		expect(() => parseToolTiers("bash=root", "X")).toThrow(ConfigError);
		expect(() => parseToolTiers("bash", "X")).toThrow(ConfigError);
	});
});
