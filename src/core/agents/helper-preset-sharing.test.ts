import { expect, test } from "bun:test";
import type { Speaker } from "../identity/speakers.ts";
import { describeDb } from "../testing/database.ts";
import { fx, useTeamFixture } from "./agent-team-fixture.ts";
import type { HelperPreset } from "./helper-presets.ts";
import { inTurn, scopeOf, settle } from "./helper-test-kit.ts";

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
	skills: [],
};

const tool = (
	agent: string,
	action: Parameters<typeof fx.team.helperPreset>[1],
	speaker?: Speaker,
) => inTurn(agent, (caller) => fx.team.helperPreset(caller, action), speaker);
const recruit = (agent: string, preset: string, speaker?: Speaker) =>
	inTurn(
		agent,
		(caller) => fx.team.helperCreate(caller, { preset, task: "Write it." }),
		speaker,
	);

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("shared temp knight presets", () => {
	useTeamFixture();

	test("a preset is shared with none, every knight, or the knights named", async () => {
		const saved = await fx.team.savePreset("coordinator", WRITER);
		expect(saved.preset.sharedWith).toBeUndefined();
		expect(await fx.team.usablePresets("infra")).toEqual([]);
		await fx.team.savePreset("coordinator", WRITER, "all");
		expect((await fx.team.presets("coordinator"))[0]?.sharedWith).toBe("all");
		expect((await fx.team.usablePresets("infra")).map((p) => p.agent)).toEqual([
			"coordinator",
		]);
		// The saving agent is dropped from the list.
		const named = await fx.team.savePreset("coordinator", WRITER, [
			"doctor",
			"coordinator",
		]);
		expect(named.preset.sharedWith).toEqual(["doctor"]);
		expect(await fx.team.usablePresets("infra")).toEqual([]);
		expect((await fx.team.usablePresets("doctor"))[0]?.name).toBe("writer");
		await fx.team.savePreset("coordinator", WRITER, null);
		expect(await fx.team.usablePresets("doctor")).toEqual([]);
		await expect(
			fx.team.savePreset("coordinator", WRITER, ["nobody"]),
		).rejects.toThrow("only with knights; not one: nobody");
	});

	test("an agent's save keeps the sharing an owner set, and an owner's save without it too", async () => {
		await fx.team.savePreset("coordinator", WRITER, ["infra"]);
		await tool("coordinator", {
			kind: "set",
			preset: { ...WRITER, prompt: "Another prompt." },
		});
		await fx.team.savePreset("coordinator", { ...WRITER, prompt: "Third." });
		const [kept] = await fx.team.presets("coordinator");
		expect(kept?.prompt).toBe("Third.");
		expect(kept?.sharedWith).toEqual(["infra"]);
	});

	test("the list shows its own first, then shared ones by their qualified names", async () => {
		await fx.team.savePreset("coordinator", WRITER, "all");
		await fx.team.savePreset("doctor", { ...WRITER, name: "medic" }, "all");
		await tool("infra", {
			kind: "set",
			preset: { ...WRITER, name: "ops" },
		});
		const lines = (await tool("infra", { kind: "list" })).split("\n");
		expect(lines.map((line) => line.split(":")[0])).toEqual([
			"ops",
			"coordinator/writer [shared by coordinator]",
			"doctor/medic [shared by doctor]",
		]);
		expect(await tool("infra", { kind: "list", name: "medic" })).toContain(
			'Preset "doctor/medic" (shared by doctor)',
		);
		expect(
			await tool("infra", { kind: "list", name: "coordinator/writer" }),
		).toContain("Display name: Writer");
	});

	test("recruiting takes its own name over a shared one and refuses an ambiguous bare name", async () => {
		await fx.team.savePreset("coordinator", WRITER, "all");
		await fx.team.savePreset("doctor", WRITER, ["infra"]);
		await expect(recruit("infra", "writer")).rejects.toThrow(
			"name one of coordinator/writer, doctor/writer",
		);
		await recruit("infra", "doctor/writer");
		await settle();
		expect(fx.store.agent("infra-1")?.preset).toBe("doctor/writer");
		await tool("infra", {
			kind: "set",
			preset: { ...WRITER, displayName: "Own writer" },
		});
		await recruit("infra", "writer");
		await settle();
		expect(fx.store.agent("infra-2")?.displayName).toBe("Own writer");
		expect(fx.store.agent("infra-2")?.preset).toBe("writer");
		// A bare name one shared preset alone has records its qualified name.
		await fx.team.savePreset("doctor", { ...WRITER, name: "medic" }, "all");
		await recruit("infra", "medic");
		await settle();
		expect(fx.store.agent("infra-3")?.preset).toBe("doctor/medic");
	});

	test("a preset not shared with the caller is unknown to it", async () => {
		await fx.team.savePreset("coordinator", WRITER, ["doctor"]);
		await expect(recruit("infra", "coordinator/writer")).rejects.toThrow(
			'no preset "coordinator/writer"',
		);
	});

	test("only the saving agent or an owner changes or deletes a preset", async () => {
		await fx.team.savePreset("coordinator", WRITER, "all");
		await expect(
			tool("infra", { kind: "delete", name: "coordinator/writer" }),
		).rejects.toThrow("only coordinator or an owner may delete it");
		await expect(
			tool("infra", { kind: "delete", name: "writer" }),
		).rejects.toThrow('no preset "writer"');
		// Saving under the same name makes the agent its own, leaving the shared one as it was.
		await tool("infra", {
			kind: "set",
			preset: { ...WRITER, prompt: "Mine." },
		});
		const [theirs] = await fx.team.presets("coordinator");
		expect(theirs?.prompt).toBe(WRITER.prompt);
		expect((await fx.team.presets("infra"))[0]?.sharedWith).toBeUndefined();
	});

	test("a shared preset is checked at the caller's tier against the caller's skills", async () => {
		await fx.team.savePreset(
			"coordinator",
			{ ...WRITER, skills: ["kit-do"] },
			"all",
		);
		await expect(recruit("infra", "writer", MEMBER)).rejects.toThrow(
			"only skills you carry",
		);
		expect(fx.team.helpersOf("infra")).toHaveLength(0);
		await recruit("infra", "writer");
		await settle();
		expect(fx.skills.carriedNames("infra-1")).toEqual(["kit-do"]);
	});

	test("the prompt tells a knight to look for a preset to recruit, naming none", async () => {
		await fx.team.savePreset("coordinator", { ...WRITER, name: "blog-writer" });
		const prompt = fx.team.systemPrompt(scopeOf("coordinator"));
		expect(prompt).toContain(
			"Before making a temp knight, check helper_preset_list for a preset to recruit it from",
		);
		expect(prompt).not.toContain("blog-writer");
	});

	test("a temp knight sees no presets, shared ones included", async () => {
		await fx.team.savePreset("coordinator", WRITER, "all");
		await recruit("infra", "writer");
		await settle();
		await expect(fx.team.usablePresets("infra-1")).rejects.toThrow(
			"is a temp knight",
		);
		await expect(
			fx.team.savePreset("coordinator", WRITER, ["infra-1"]),
		).rejects.toThrow("not one: infra-1");
	});
});
