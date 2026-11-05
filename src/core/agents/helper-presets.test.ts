import { describe, expect, test } from "bun:test";
import type { Speaker } from "../identity/speakers.ts";
import { describeDb } from "../testing/database.ts";
import { fx, useTeamFixture } from "./agent-team-fixture.ts";
import type { HelperPreset } from "./helper-presets.ts";
import {
	asCoordinator,
	inTurn,
	SCOUT,
	scopeOf,
	settle,
} from "./helper-test-kit.ts";

const MEMBER: Speaker = {
	id: "2",
	name: "Bo",
	tier: "member",
	principalId: "2",
};

const WRITER: HelperPreset = {
	name: "writer",
	displayName: "Writer",
	prompt: "You write the blog post from the outline you are given.",
	skills: ["kit-do"],
	character: { class: "bard" } as HelperPreset["character"],
};

const save = (preset: HelperPreset, speaker?: Speaker, agent = "coordinator") =>
	inTurn(
		agent,
		(caller) => fx.team.helperPreset(caller, { kind: "set", preset }),
		speaker,
	);
const list = (name?: string, agent = "coordinator") =>
	inTurn(agent, (caller) =>
		fx.team.helperPreset(caller, { kind: "list", ...(name ? { name } : {}) }),
	);

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("temp knight presets", () => {
	useTeamFixture();

	test("save, list, show, replace, and delete", async () => {
		expect(await list()).toContain("no presets");
		expect(await save(WRITER)).toContain("Created");
		const line = await list();
		expect(line).toContain('writer: "Writer" (skills: kit-do)');
		expect(line).toContain("You write the blog post");
		expect(await list("writer")).toContain(
			"Skills: kit-do\nClass: bard\nPrompt:\nYou write",
		);
		expect(
			await save({ ...WRITER, prompt: "Another prompt.", skills: [] }),
		).toContain("Replaced");
		expect(await list("writer")).toContain("Skills: none");
		expect(
			await asCoordinator((caller) =>
				fx.team.helperPreset(caller, { kind: "delete", name: "writer" }),
			),
		).toContain("Deleted");
		await expect(
			asCoordinator((caller) =>
				fx.team.helperPreset(caller, { kind: "delete", name: "writer" }),
			),
		).rejects.toThrow('no preset "writer"');
	});

	test("an agent keeps at most 20, and a bad name is refused", async () => {
		for (let n = 0; n < 20; n += 1)
			await fx.store.presets.set("coordinator", { ...WRITER, name: `p-${n}` });
		await expect(save({ ...WRITER, name: "p-20" })).rejects.toThrow(
			"20 presets",
		);
		// Replacing one at the cap is allowed.
		expect(await save({ ...WRITER, name: "p-3" })).toContain("Replaced");
		await expect(save({ ...WRITER, name: "Bad Name" })).rejects.toThrow(
			"not a preset name",
		);
	});

	test("only the agent that saved a preset sees and uses it", async () => {
		await save(WRITER);
		expect(await list(undefined, "infra")).toContain("no presets");
		await expect(
			inTurn("infra", (caller) =>
				fx.team.helperCreate(caller, { preset: "writer", task: "Write." }),
			),
		).rejects.toThrow('no preset "writer"');
	});

	test("unknown skills and, for a member, skills or a model beyond its own are refused at save", async () => {
		await expect(save({ ...WRITER, skills: ["nope"] })).rejects.toThrow(
			"Unknown skills",
		);
		await expect(save(WRITER, MEMBER)).rejects.toThrow("only skills you carry");
		await expect(
			save({ ...WRITER, skills: [], model: "a/b" }, MEMBER),
		).rejects.toThrow("higher tier");
		expect(await save({ ...WRITER, skills: [] }, MEMBER)).toContain("Created");
	});

	test("helper_create makes the preset's temp knight", async () => {
		await save(WRITER);
		await asCoordinator((caller) =>
			fx.team.helperCreate(caller, { preset: "writer", task: "Write it." }),
		);
		await settle();
		const made = fx.store.agent("coordinator-1");
		expect(made?.displayName).toBe("Writer");
		expect(made?.prompt).toBe(WRITER.prompt);
		expect(made?.character?.class).toBe("bard");
		expect(fx.skills.carriedNames("coordinator-1")).toEqual(["kit-do"]);
	});

	test("the call's fields replace the preset's, and its skills are added without repeats", async () => {
		await save(WRITER);
		await asCoordinator((caller) =>
			fx.team.helperCreate(caller, {
				preset: "writer",
				displayName: "Editor",
				prompt: "You edit.",
				skills: ["kit-do"],
				task: "Edit it.",
			}),
		);
		await settle();
		const made = fx.store.agent("coordinator-1");
		expect(made?.displayName).toBe("Editor");
		expect(made?.prompt).toBe("You edit.");
		expect(fx.skills.carriedNames("coordinator-1")).toEqual(["kit-do"]);
	});

	test("an unknown preset lists the caller's, and no prompt without a preset is refused", async () => {
		await save(WRITER);
		await expect(
			asCoordinator((caller) =>
				fx.team.helperCreate(caller, { preset: "nope", task: "x" }),
			),
		).rejects.toThrow("Your presets: writer.");
		await expect(
			asCoordinator((caller) =>
				fx.team.helperCreate(caller, { displayName: "X", task: "x" }),
			),
		).rejects.toThrow("Give display_name and prompt");
	});

	test("a preset saved earlier is checked again for the speaker making it now", async () => {
		await save(WRITER);
		await expect(
			inTurn(
				"coordinator",
				(caller) =>
					fx.team.helperCreate(caller, { preset: "writer", task: "Write." }),
				MEMBER,
			),
		).rejects.toThrow("only skills you carry");
		expect(fx.team.helpersOf("coordinator")).toHaveLength(0);
	});

	test("a temp knight is not offered the preset tools", async () => {
		await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
		await settle();
		const helper = fx.store.agent("coordinator-1");
		const tools = fx.team.selection(scopeOf("coordinator-1")).tools;
		expect(helper?.parent).toBe("coordinator");
		expect(tools).not.toContain("helper_preset_set");
		expect(fx.team.selection(scopeOf("coordinator")).tools).toContain(
			"helper_preset_set",
		);
	});
});

describeDb("temp knight presets with helpers off", () => {
	useTeamFixture({ helpers: false });
	test("the preset tools are not offered", () => {
		const tools = fx.team.selection(scopeOf("coordinator")).tools;
		for (const tool of [
			"helper_preset_set",
			"helper_preset_list",
			"helper_preset_delete",
		])
			expect(tools).not.toContain(tool);
	});
});

describe("preset names", () => {
	test("the tool's schema matches the rule the save checks", async () => {
		const { helperPresetToolDefs } = await import("./helper-preset-tools.ts");
		const [set] = helperPresetToolDefs(
			{ helperPreset: async () => "" },
			scopeOf("a"),
			true,
		);
		expect(JSON.stringify(set?.parameters)).toContain("^[a-z0-9-]{1,32}$");
	});
});
