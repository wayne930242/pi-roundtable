import { describe, expect, test } from "bun:test";
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
		avatarPrompt: "a fox in a green scarf",
		channelId: "10",
		status: "active",
	};
	const panel = (canDraw: boolean) => {
		const commands = new AgentCommands({
			store: {
				agentByChannel: () => agent,
				groupByChannel: () => undefined,
				agent: () => agent,
			},
			team: {
				modelOf: () => ({ model: "a/b", thinking: "auto" }),
			} as never,
			studio: { url: () => "https://x/a.png", canDraw },
			skills: { carried: () => ({ skills: [], missing: [] }) },
		});
		return JSON.stringify(commands.panel("10").components[0]?.toJSON());
	};

	test("with an image provider it shows the avatar prompt and the three avatar buttons", () => {
		const json = panel(true);
		expect(json).toContain("a fox in a green scarf");
		for (const action of ["redraw", "newprompt", "editavatar"])
			expect(json).toContain(`${action}:scout`);
	});

	test("without one it says so instead of the avatar prompt and offers only the other buttons", () => {
		const json = panel(false);
		expect(json).toContain("No image provider is configured");
		expect(json).not.toContain("a fox in a green scarf");
		for (const action of ["redraw", "newprompt", "editavatar"])
			expect(json).not.toContain(`${action}:scout`);
		for (const action of ["edit", "model"])
			expect(json).toContain(`:${action}:scout`);
	});
});
