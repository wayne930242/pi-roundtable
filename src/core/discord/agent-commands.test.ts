import { describe, expect, test } from "bun:test";
import {
	CATALOG,
	CLASS_IDS,
	resolveCharacter,
} from "../../characters/index.ts";
import type { Agent } from "../agents/agent-store.ts";
import { messages } from "../i18n/index.ts";
import { AgentCommands, formModels, skillsText } from "./agent-commands.ts";

describe("formModels", () => {
	const usable = [
		"claude-bridge/claude-opus-5-5",
		"claude-bridge/claude-haiku-4-5",
		"claude-bridge/claude-sonnet-5-5",
		"openai-codex/gpt-6-luna",
		"openai-codex/gpt-6-sol",
		"openai-codex/gpt-6-astra",
	];

	test("offers the five form models in order, leaving out other usable ones", () => {
		expect(formModels(usable)).toEqual([
			"openai-codex/gpt-6-astra",
			"openai-codex/gpt-6-sol",
			"openai-codex/gpt-6-luna",
			"claude-bridge/claude-sonnet-5-5",
			"claude-bridge/claude-opus-5-5",
		]);
	});

	test("leaves out form models the host cannot run", () => {
		expect(
			formModels(["claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol"]),
		).toEqual(["openai-codex/gpt-6-sol", "claude-bridge/claude-opus-5-5"]);
	});

	test("puts the agent's current model first when the form does not offer it", () => {
		expect(formModels(usable, "claude-bridge/claude-haiku-4-5")[0]).toBe(
			"claude-bridge/claude-haiku-4-5",
		);
		expect(formModels(usable, "openai-codex/gpt-6-sol")).toEqual(
			formModels(usable),
		);
	});
});

describe("skillsText", () => {
	test("lists carried skills with the built-in one marked, and missing ones with their reason", () => {
		const skill = (name: string) => ({
			name,
			description: "Use when x.",
			file: `/s/${name}/SKILL.md`,
		});
		const text = messages();
		expect(
			skillsText({
				skills: [skill("writing-skills"), skill("example-skill")],
				missing: [{ name: "gone", reason: "file not found" }],
			}),
		).toBe(
			`${text.agentSkills([text.agentSkillBuiltin("writing-skills"), "`example-skill`"])}\n${text.agentSkillMissing("gone", "file not found")}`,
		);
	});
});

describe("the agent panel", () => {
	const agent: Agent = {
		name: "scout",
		displayName: "Scout",
		prompt: "You scout.",
		avatarPrompt: "",
		avatarHash: "a".repeat(64),
		channelId: "10",
		status: "active",
		character: resolveCharacter({ class: "ranger", palette: "vert" }),
	};
	const dressed: string[] = [];
	const commands = () =>
		new AgentCommands({
			store: {
				agentByChannel: () => agent,
				groupByChannel: () => undefined,
				agent: () => agent,
			},
			team: {
				modelOf: () => ({ model: "a/b", thinking: "auto" }),
				dress: async (name: string, input: unknown) => {
					dressed.push(`${name} ${JSON.stringify(input)}`);
					return { ...agent, avatarHash: "b".repeat(64) };
				},
			} as never,
			studio: {
				url: (hash: string | undefined) => `https://x/${hash}.png`,
			},
			skills: { carried: () => ({ skills: [], missing: [] }) },
		});
	const panel = () =>
		JSON.parse(
			JSON.stringify(commands().panel("10").components[0]?.toJSON()),
		) as { components: Array<Record<string, unknown>> };

	/** The select menus of the panel, by custom id. */
	function selects() {
		const found: Array<{ custom_id: string; options: { value: string }[] }> =
			[];
		const walk = (node: unknown) => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (node === null || typeof node !== "object") return;
			const object = node as Record<string, unknown>;
			if (object.type === 3) found.push(object as never);
			Object.values(object).forEach(walk);
		};
		walk(panel());
		return found;
	}

	test("it shows a class select of 24 and a color select of 8, and no avatar prompt or redraw button", () => {
		const menus = selects();
		expect(menus.map((m) => m.custom_id)).toEqual([
			"roundtable:agent:class:scout",
			"roundtable:agent:color:scout",
		]);
		expect(menus[0]?.options.map((o) => o.value)).toEqual([...CLASS_IDS]);
		expect(menus[1]?.options.map((o) => o.value)).toEqual(
			Object.keys(CATALOG.palettes),
		);
		const json = JSON.stringify(panel());
		for (const action of ["redraw", "newprompt", "editavatar"])
			expect(json).not.toContain(`${action}:scout`);
		expect(json).not.toContain("Avatar prompt");
		for (const action of ["edit", "model"])
			expect(json).toContain(`:${action}:scout`);
	});

	test("the select that matches the agent's look is the default", () => {
		const [classes, colors] = selects() as unknown as Array<{
			options: { value: string; default?: boolean }[];
		}>;
		expect(classes?.options.find((o) => o.default)?.value).toBe("ranger");
		expect(colors?.options.find((o) => o.default)?.value).toBe("vert");
	});

	test("choosing a class or a color dresses the agent and edits the reply with the new picture", async () => {
		for (const [action, value, input] of [
			["class", "monk", { class: "monk" }],
			["color", "rose", { palette: "rose" }],
		] as const) {
			dressed.length = 0;
			const edits: unknown[] = [];
			await commands().select({
				customId: `roundtable:agent:${action}:scout`,
				values: [value],
				editReply: async (reply: unknown) => void edits.push(reply),
			} as never);
			expect(dressed).toEqual([`scout ${JSON.stringify(input)}`]);
			expect(JSON.stringify(edits)).toContain(
				`https://x/${"b".repeat(64)}.png`,
			);
		}
	});
});
