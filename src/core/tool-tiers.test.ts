import { describe, expect, test } from "bun:test";
import { silentLogger } from "./log.ts";
import {
	CORE_TOOL_TIERS,
	currentToolNames,
	toolsForTier,
	toolTiers,
} from "./tool-tiers.ts";

describe("default tiers", () => {
	const tiers = toolTiers();

	test("members may ask the owner, compact, and read an attachment", () => {
		for (const tool of ["ask_user", "compact_session", "read_attachment"])
			expect(tiers.minTier(tool)).toBe("member");
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

	test("the core names only its own tools; every feature declares its own with its plugin", () => {
		expect(Object.keys(CORE_TOOL_TIERS).sort()).toEqual([
			"ask_user",
			"compact_session",
			"read_attachment",
		]);
	});
});

describe("a tool renamed since 0.8", () => {
	test("warns once per host logger when an old name is used in tiers or selections, and never for the new name", () => {
		const messages: unknown[] = [];
		const logger = {
			...silentLogger(),
			warn: (message: unknown) => {
				messages.push(message);
			},
		};
		toolTiers({ notify: "member" }, logger);
		currentToolNames(["notify"], logger);
		expect(messages).toEqual([]);
		toolTiers({ notify_owner: "member" }, logger);
		currentToolNames(["notify_owner"], logger);
		toolTiers({ notify_owner: "admin" }, logger);
		expect(messages).toEqual([
			"deprecated: notify_owner is now notify; update selections and toolTiers before 1.0",
		]);
		const other: unknown[] = [];
		currentToolNames(["notify_owner"], {
			...silentLogger(),
			warn: (message: unknown) => {
				other.push(message);
			},
		});
		expect(other).toHaveLength(1);
	});

	test("the operator's tier under its old name, such as notify_owner, is the new name's, unless the new name has its own", () => {
		expect(toolTiers({ notify_owner: "member" }).minTier("notify")).toBe(
			"member",
		);
		expect(
			toolTiers({ notify_owner: "member", notify: "admin" }).minTier("notify"),
		).toBe("admin");
		expect(toolTiers().minTier("notify")).toBe("owner");
	});
});

describe("toolsForTier", () => {
	const tiers = toolTiers();
	tiers.declare("feature", { tool_list: "member", tool_create: "admin" });
	const all = ["tool_list", "tool_create", "bash", "some_plugin_tool"];

	test("each tier gets the tools at or below it, in order", () => {
		expect(toolsForTier(all, "member", tiers)).toEqual(["tool_list"]);
		expect(toolsForTier(all, "admin", tiers)).toEqual([
			"tool_list",
			"tool_create",
		]);
		expect(toolsForTier(all, "owner", tiers)).toEqual(all);
	});

	test("an operator's map lowers or raises a tool", () => {
		const custom = toolTiers({ bash: "admin", tool_list: "owner" });
		custom.declare("feature", { tool_list: "member", tool_create: "admin" });
		expect(toolsForTier(all, "member", custom)).toEqual([]);
		expect(toolsForTier(all, "admin", custom)).toEqual(["tool_create", "bash"]);
	});

	test("a plugin's declared tier is read at use time; the operator's still wins", () => {
		const table = toolTiers({ plugin_b: "owner" });
		expect(table.minTier("plugin_a")).toBe("owner");
		table.declare("a", { plugin_a: "member" });
		table.declare("b", { plugin_b: "member" });
		expect(table.minTier("plugin_a")).toBe("member");
		expect(table.minTier("plugin_b")).toBe("owner");
	});

	test("a plugin declaring its own tool again, as on a retried start, replaces it", () => {
		const table = toolTiers();
		table.declare("a", { plugin_a: "member" });
		table.declare("a", { plugin_a: "admin" });
		expect(table.minTier("plugin_a")).toBe("admin");
	});

	test("a tool two plugins declare names both plugins and the fix", () => {
		const table = toolTiers();
		table.declare("a", { shared_tool: "member" });
		expect(() => table.declare("b", { shared_tool: "member" })).toThrow(
			"plugin b: tool shared_tool is already defined by plugin a. Rename one of the two tools.",
		);
	});
});
