import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { defineTool } from "../define.ts";
import { NotLinkedError, PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import type {
	Contribution,
	PluginContext,
	RoundtablePlugin,
} from "../plugin.ts";
import { toolTiers } from "../tool-tiers.ts";
import {
	collectContributions,
	linkSessions,
	nearest,
} from "./contributions.ts";

/** A context the plugins under test never read. */
const context = { logger: silentLogger() } as unknown as PluginContext;

const plugin = (
	name: string,
	contribution: Contribution | (() => Contribution),
): RoundtablePlugin => ({
	name,
	setup: () =>
		typeof contribution === "function" ? contribution() : contribution,
});

const tool = (name: string, minTier: "member" | "admin" | "owner" = "member") =>
	defineTool({
		name,
		description: "A tool.",
		parameters: Type.Object({}),
		minTier,
		run: () => "ok",
	});

const collect = (plugins: RoundtablePlugin[], tiers = toolTiers()) =>
	collectContributions(plugins, context, tiers);

describe("collectContributions", () => {
	test("names the part a typo meant, or lists the parts", async () => {
		await expect(
			collect([plugin("p", { serivces: [] } as unknown as Contribution)]),
		).rejects.toThrow(
			'plugin p: setup returned an unknown part "serivces". Did you mean "services"? The parts are services,',
		);
		await expect(
			collect([plugin("p", { zzzzzz: [] } as unknown as Contribution)]),
		).rejects.toThrow(
			'plugin p: setup returned an unknown part "zzzzzz". The parts are services,',
		);
	});

	test("refuses a plugin that adds nothing, and says what to give it", async () => {
		await expect(collect([plugin("empty", {})])).rejects.toThrow(
			"plugin empty adds nothing. Give it a part (tools, services, channels, and so on), a migration, or a provider, or remove it.",
		);
	});

	test("a setup that throws or returns no object is named and keeps its cause", async () => {
		const boom = new Error("boom");
		const failing = collect([
			plugin("p", () => {
				throw boom;
			}),
		]);
		await expect(failing).rejects.toThrow(
			"plugin p: setup failed: boom. Fix the error, or remove the plugin.",
		);
		await expect(failing).rejects.toHaveProperty("cause", boom);
		await expect(
			collect([
				plugin("early", () => {
					throw new NotLinkedError("parts are linked later.");
				}),
			]),
		).rejects.toThrow(
			"plugin early: setup failed: parts are linked later. Fix the error, or remove the plugin.",
		);
		await expect(
			collect([
				{ name: "q", setup: () => undefined as unknown as Contribution },
			]),
		).rejects.toThrow(
			"plugin q: setup must return an object of the parts it adds; return {} to add none.",
		);
	});

	test("a service, a session tool, or a hold rule two plugins register names both plugins", async () => {
		const service = { name: "sweeper" };
		await expect(
			collect([
				plugin("a", { services: [service] }),
				plugin("b", { services: [service] }),
			]),
		).rejects.toThrow(
			"plugin b: service sweeper is already registered by plugin a. Rename one of the two.",
		);
		const rule = { name: "shell", describe: () => undefined };
		await expect(
			collect([
				plugin("a", { holdRules: [rule] }),
				plugin("b", { holdRules: [rule] }),
			]),
		).rejects.toThrow(
			"plugin b: hold rule shell is already registered by plugin a. Rename one of the two.",
		);
	});

	test("a tool two plugins define names both plugins", async () => {
		await expect(
			collect([
				plugin("a", { tools: [tool("note_add")] }),
				plugin("b", { tools: [tool("note_add")] }),
			]),
		).rejects.toThrow(
			"plugin b: tool note_add is already defined by plugin a. Rename one of the two tools.",
		);
	});

	test("a plugin's tools carry their tier, their hold rule, and their place among the agent's tools", async () => {
		const tiers = toolTiers({ note_list: "admin" });
		const held = defineTool({
			name: "note_clear",
			description: "Clear the notes.",
			parameters: Type.Object({}),
			minTier: "admin",
			agent: false,
			hold: () => "clear every note",
			run: () => "cleared",
		});
		const registry = await collect(
			[
				plugin("notes", {
					tools: [tool("note_add"), tool("note_list", "member"), held],
				}),
			],
			tiers,
		);
		expect(tiers.minTier("note_add")).toBe("member");
		// The operator's setting wins over the plugin's.
		expect(tiers.minTier("note_list")).toBe("admin");
		expect(tiers.minTier("note_clear")).toBe("admin");
		const linked = linkSessions(registry);
		expect(linked.agentTools).toEqual(["note_add", "note_list"]);
		expect(linked.holds("note_clear", {}, {})).toBe("clear every note");
		expect(linked.holds("note_add", {}, {})).toBeUndefined();
	});

	test("seeds and prompt sections are collected in contribution order", async () => {
		const seed = (name: string) => ({
			name,
			displayName: name,
			prompt: "p",
			avatarPrompt: "a",
		});
		const section = (name: string) => ({ name, build: () => name });
		const registry = await collect([
			plugin("a", { seeds: [seed("one")], prompt: [section("x")] }),
			plugin("b", { seeds: [seed("two")], prompt: [section("y")] }),
		]);
		const linked = linkSessions(registry);
		expect(linked.seeds.map((s) => s.name)).toEqual(["one", "two"]);
		expect(linked.prompt.map((s) => s.name)).toEqual(["x", "y"]);
	});

	test("every plugin's agent selection is merged when read, each name once", async () => {
		let groups = ["mail"];
		const registry = await collect([
			plugin("a", {
				agentSelection: () => ({ tools: ["web_search"], groups }),
			}),
			plugin("b", {
				agentSelection: () => ({
					tools: ["web_search", "notes"],
					groups: ["mail", "calendar"],
				}),
			}),
		]);
		const linked = linkSessions(registry);
		expect(linked.agentSelection()).toEqual({
			tools: ["web_search", "notes"],
			groups: ["mail", "calendar"],
		});
		// Read again at each turn, so a set that changes while the process runs stays current.
		groups = ["docs"];
		expect(linked.agentSelection().groups).toEqual([
			"docs",
			"mail",
			"calendar",
		]);
		expect(
			linkSessions(
				await collect([plugin("c", { dashboard: ["a line"] })]),
			).agentSelection(),
		).toEqual({ tools: [], groups: [] });
	});

	test("every refusal is a PluginError", async () => {
		await expect(collect([plugin("empty", {})])).rejects.toBeInstanceOf(
			PluginError,
		);
	});
});

describe("nearest", () => {
	test("finds a close word and nothing for a far one", () => {
		const known = ["services", "events", "interactions"];
		expect(nearest("serivces", known)).toBe("services");
		expect(nearest("event", known)).toBe("events");
		expect(nearest("banana", known)).toBeUndefined();
	});
});
