import { describe, expect, test } from "bun:test";
import { messages } from "../i18n/index.ts";
import { formModels, skillsText } from "./agent-commands.ts";

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
