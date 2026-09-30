import { describe, expect, test } from "bun:test";
import { PluginError } from "./errors.ts";
import { compileSessionPlan, planOrder, type SessionTool } from "./sessions.ts";

const tool = (name: string, phase: SessionTool["phase"]): SessionTool => ({
	name,
	phase,
	...(phase === "compaction" ? { engine: `${name}-engine` } : {}),
	snapshot: () => ({ revision: 0, factory: () => null }),
});

const names = (tools: readonly SessionTool[]) => tools.map((t) => t.name);

describe("compileSessionPlan", () => {
	test("orders tools, then the compactor, then MCP, keeping registration order in each", () => {
		const plan = compileSessionPlan([
			tool("mcp-a", "mcp"),
			tool("memory", "tools"),
			tool("summarizer", "compaction"),
			tool("notify", "tools"),
			tool("mcp-b", "mcp"),
		]);
		expect(names(planOrder(plan))).toEqual([
			"memory",
			"notify",
			"summarizer",
			"mcp-a",
			"mcp-b",
		]);
	});

	test("a plan without a compactor has none", () => {
		const plan = compileSessionPlan([tool("memory", "tools")]);
		expect(plan.compaction).toBeUndefined();
		expect(names(planOrder(plan))).toEqual(["memory"]);
	});

	test("refuses a name registered twice", () => {
		expect(() =>
			compileSessionPlan([tool("memory", "tools"), tool("memory", "mcp")]),
		).toThrow(
			new PluginError(
				"session tool memory is registered twice. Rename one of the two.",
			),
		);
	});

	test("refuses the names of the core's own extensions", () => {
		for (const name of [
			"read-attachment",
			"confirmation-gate",
			"ask-user",
			"self-compact-guard",
			"profile-tools",
		]) {
			expect(() => compileSessionPlan([tool(name, "tools")])).toThrow(
				new PluginError(
					`session tool ${name} takes a core extension name. Rename it.`,
				),
			);
		}
	});

	test("refuses a compactor that names no engine", () => {
		const { engine: _engine, ...unmarked } = tool("summarizer", "compaction");
		expect(() => compileSessionPlan([unmarked])).toThrow(
			new PluginError(
				"compactor summarizer needs an engine: the value its compactions record as details.engine.",
			),
		);
	});

	test("refuses a second compactor", () => {
		expect(() =>
			compileSessionPlan([
				tool("summarizer", "compaction"),
				tool("pi", "compaction"),
			]),
		).toThrow(
			new PluginError(
				"only one compactor may run; got summarizer, pi. Keep one.",
			),
		);
	});
});
