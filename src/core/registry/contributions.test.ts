import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { serviceKey } from "../contract/services.ts";
import { defineTool } from "../define.ts";
import { NotLinkedError, PluginError } from "../errors.ts";
import { type Logger, silentLogger } from "../log.ts";
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
import { ServiceRegistry } from "./services.ts";

const ANSWER = serviceKey<number>("test.answer");

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

	test("a plugin that only reads a service in setup is not one that adds nothing", async () => {
		const services = new ServiceRegistry([]);
		services.preset(ANSWER, 42);
		const read: number[] = [];
		await collectContributions(
			[
				{
					name: "reader",
					setup: ({ services: given }) => {
						read.push(given.get(ANSWER));
						return {};
					},
				},
			],
			context,
			toolTiers(),
			services,
		);
		expect(read).toEqual([42]);
	});

	test("refuses a plugin that adds nothing, and says what to give it", async () => {
		await expect(collect([plugin("empty", {})])).rejects.toThrow(
			"plugin empty adds nothing. Give it a part (tools, services, channels, and so on), a migration, or a provider, or remove it.",
		);
	});

	test("a plugin's toolTiers are declared for its raw session tools, and alone they count as adding something", async () => {
		const tiers = toolTiers();
		await collect(
			[plugin("feature", { toolTiers: { feature_list: "member" } })],
			tiers,
		);
		expect(tiers.minTier("feature_list")).toBe("member");
		expect(tiers.minTier("feature_other")).toBe("owner");
	});

	test("toolTiers refuse a tier that is not one, and a tool two plugins name", async () => {
		await expect(
			collect([
				plugin("p", { toolTiers: { t: "root" } } as unknown as Contribution),
			]),
		).rejects.toThrow(
			'plugin p: toolTiers names tool t at tier "root"; use one of member, admin, owner.',
		);
		await expect(
			collect([
				plugin("a", { toolTiers: { shared: "member" } }),
				plugin("b", { toolTiers: { shared: "admin" } }),
			]),
		).rejects.toThrow(
			"plugin b: tool shared is already defined by plugin a. Rename one of the two tools.",
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

	test("a persona is found by its conversation kind, and its prompt is read at each lookup", async () => {
		let prompt = "You are a tutor.";
		const linked = linkSessions(
			await collect([
				plugin("a", { personas: [{ kind: "study", prompt: () => prompt }] }),
				plugin("b", { personas: [{ kind: "chat", prompt: () => "Chat." }] }),
			]),
		);
		expect(linked.persona("study")).toBe("You are a tutor.");
		expect(linked.persona("chat")).toBe("Chat.");
		expect(linked.persona("owner")).toBeUndefined();
		// Read when a session is made, so text from the message catalog is in the host's language.
		prompt = "Changed.";
		expect(linked.persona("study")).toBe("Changed.");
	});

	test("a persona's memory is speaker by default, none when it says so, and nothing else", async () => {
		const linked = linkSessions(
			await collect([
				plugin("a", {
					personas: [
						{ kind: "study", prompt: () => "p" },
						{ kind: "quiz", prompt: () => "q", memory: "none" },
					],
				}),
			]),
		);
		expect(linked.personaMemory?.("study")).toBe("speaker");
		expect(linked.personaMemory?.("quiz")).toBe("none");
		expect(linked.personaMemory?.("owner")).toBe("speaker");
		await expect(
			collect([
				plugin("a", {
					personas: [
						{ kind: "quiz", prompt: () => "q", memory: "owner" as "none" },
					],
				}),
			]),
		).rejects.toThrow('has memory "owner"; expected "speaker" or "none"');
	});

	test("two personas of one kind are refused, naming both plugins", async () => {
		const persona = { kind: "study", prompt: () => "p" };
		await expect(
			collect([
				plugin("a", { personas: [persona] }),
				plugin("b", { personas: [persona] }),
			]),
		).rejects.toThrow(
			'plugin b: persona kind "study" is already registered by plugin a. Keep one persona per kind.',
		);
		await expect(
			collect([plugin("a", { personas: [persona, persona] })]),
		).rejects.toThrow('persona kind "study" is already registered by plugin a');
	});

	test("the agent kind is reserved, and a persona needs a kind and a prompt function", async () => {
		await expect(
			collect([
				plugin("a", { personas: [{ kind: "agent", prompt: () => "p" }] }),
			]),
		).rejects.toThrow(
			'plugin a: the persona kind "agent" is reserved for the agent server\'s agents.',
		);
		await expect(
			collect([plugin("a", { personas: [{ kind: "", prompt: () => "p" }] })]),
		).rejects.toThrow("plugin a: a persona needs a kind");
		await expect(
			collect([
				plugin("a", {
					personas: [
						{ kind: "study" } as unknown as { kind: string; prompt(): string },
					],
				}),
			]),
		).rejects.toThrow('the persona of kind "study" needs a prompt()');
	});

	test("two background targets of one name are refused, naming both plugins", async () => {
		const target = { name: "support", label: () => "Support" };
		await expect(
			collect([
				plugin("a", { backgroundTargets: [target] }),
				plugin("b", { backgroundTargets: [target] }),
			]),
		).rejects.toThrow(
			'plugin b: background target "support" is already registered by plugin a. Keep one target per name.',
		);
		await expect(
			collect([plugin("a", { backgroundTargets: [target, target] })]),
		).rejects.toThrow('background target "support" is already registered');
	});

	test("direct channels are collected in contribution order, and two of one name are refused, naming both plugins", async () => {
		const channel = (name: string) => ({
			name,
			label: `a message on ${name}`,
			reaches: async () => undefined,
		});
		const registry = await collect([
			plugin("a", { directChannels: [channel("chat")] }),
			plugin("b", { directChannels: [channel("inbox")] }),
		]);
		expect(registry.directChannels.map((p) => p.name)).toEqual([
			"chat",
			"inbox",
		]);
		await expect(
			collect([
				plugin("a", { directChannels: [channel("chat")] }),
				plugin("b", { directChannels: [channel("chat")] }),
			]),
		).rejects.toThrow(
			"plugin b: direct channel chat is already registered by plugin a. Rename one of the two.",
		);
		// A plugin reads them once every plugin is set up, never during its setup.
		let early: unknown;
		let late: (() => string[]) | undefined;
		await collect([
			{
				name: "reader",
				setup: ({ directChannels }) => {
					try {
						directChannels.providers();
					} catch (error) {
						early = error;
					}
					late = () => directChannels.providers().map((p) => p.name);
					return { directChannels: [channel("chat")] };
				},
			},
		]);
		expect(String(early)).toContain(
			"direct channels are linked once every plugin is set up",
		);
		expect(late?.()).toEqual(["chat"]);
		await expect(
			collect([
				plugin("a", { directChannels: [{ ...channel(""), name: "" }] }),
			]),
		).rejects.toThrow("plugin a: a direct channel needs a name");
		await expect(
			collect([
				plugin("a", { directChannels: [{ ...channel("chat"), label: "" }] }),
			]),
		).rejects.toThrow('the direct channel "chat" needs a label');
	});

	test("a background target needs a name and a label function", async () => {
		await expect(
			collect([
				plugin("a", { backgroundTargets: [{ name: "", label: () => "x" }] }),
			]),
		).rejects.toThrow("plugin a: a background target needs a name");
		await expect(
			collect([
				plugin("a", {
					backgroundTargets: [
						{ name: "support" } as unknown as {
							name: string;
							label(): string;
						},
					],
				}),
			]),
		).rejects.toThrow('the background target "support" needs a label(locale)');
	});

	test("a plugin that adds only a background target adds something, and it is listed", async () => {
		const registry = await collect([
			plugin("a", {
				backgroundTargets: [{ name: "support", label: () => "Support" }],
			}),
		]);
		expect(registry.backgroundTargets.map((t) => t.name)).toEqual(["support"]);
	});

	test("a plugin that adds only a persona adds something", async () => {
		const registry = await collect([
			plugin("a", { personas: [{ kind: "study", prompt: () => "p" }] }),
		]);
		expect(registry.personas.map((p) => p.kind)).toEqual(["study"]);
	});

	test("the tools plugins require are merged, each name once, and alone they count as adding something", async () => {
		const registry = await collect([
			plugin("a", { requiredTools: ["read", "bash"] }),
			plugin("b", { requiredTools: ["bash", "note_add"] }),
			plugin("c", { personas: [{ kind: "study", prompt: () => "p" }] }),
		]);
		expect(linkSessions(registry).requiredTools).toEqual([
			"read",
			"bash",
			"note_add",
		]);
		const alone = await collect([plugin("d", { requiredTools: ["read"] })]);
		expect(alone.requiredTools).toEqual(["read"]);
	});

	test("each plugin's setup logs through a child that carries its name", async () => {
		const bound: Record<string, unknown>[] = [];
		const parent = {
			child: (fields: Record<string, unknown>) => {
				bound.push(fields);
				return silentLogger();
			},
		} as unknown as Logger;
		await collectContributions(
			[
				plugin("first", { dashboard: ["a"] }),
				plugin("second", { dashboard: ["b"] }),
			],
			{ ...context, logger: parent },
			toolTiers(),
		);
		expect(bound).toEqual([{ plugin: "first" }, { plugin: "second" }]);
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
