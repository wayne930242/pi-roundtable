import { expect, test } from "bun:test";
import { describeDb } from "../testing/database.ts";
import { fx, useTeamFixture } from "./agent-team-fixture.ts";
import type { HelperPreset } from "./helper-presets.ts";
import { asCoordinator, SCOUT, settle } from "./helper-test-kit.ts";

const WRITER: HelperPreset = {
	name: "writer",
	displayName: "Writer",
	prompt: "You write the blog post from the outline you are given.",
	skills: ["kit-do", "kit-do"],
	model: "test/other",
	thinking: "high",
};

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("an owner's temp knight presets", () => {
	useTeamFixture();

	test("save, replace, list, and delete, at the owner's tier", async () => {
		expect(fx.team.helpersOn()).toBe(true);
		expect(await fx.team.presets("coordinator")).toEqual([]);
		const made = await fx.team.savePreset("coordinator", WRITER);
		// Skills come back deduplicated; a model and thinking need no tier check for the owner.
		expect(made).toEqual({
			preset: { ...WRITER, skills: ["kit-do"] },
			replaced: false,
		});
		const again = await fx.team.savePreset("coordinator", {
			...WRITER,
			prompt: "Another prompt.",
		});
		expect(again.replaced).toBe(true);
		const listed = await fx.team.presets("coordinator");
		expect(listed.map((p) => p.prompt)).toEqual(["Another prompt."]);
		expect(await fx.team.deletePreset("coordinator", "writer")).toBe(true);
		expect(await fx.team.deletePreset("coordinator", "writer")).toBe(false);
	});

	test("the tool's checks refuse a bad name, an unknown skill, and a 21st preset", async () => {
		await expect(
			fx.team.savePreset("coordinator", { ...WRITER, name: "Bad Name" }),
		).rejects.toThrow("not a preset name");
		await expect(
			fx.team.savePreset("coordinator", { ...WRITER, skills: ["nope"] }),
		).rejects.toThrow("Unknown skills");
		await expect(
			fx.team.savePreset("coordinator", { ...WRITER, thinking: "lots" }),
		).rejects.toThrow("not a thinking level");
		for (let n = 0; n < 20; n += 1)
			await fx.store.presets.set("coordinator", { ...WRITER, name: `p-${n}` });
		await expect(
			fx.team.savePreset("coordinator", { ...WRITER, name: "p-20" }),
		).rejects.toThrow("20 presets");
	});

	test("an unknown agent and a temp knight are refused", async () => {
		await expect(fx.team.presets("nobody")).rejects.toThrow();
		await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
		await settle();
		await expect(fx.team.presets("coordinator-1")).rejects.toThrow(
			"is a temp knight",
		);
		await expect(fx.team.savePreset("coordinator-1", WRITER)).rejects.toThrow(
			"is a temp knight",
		);
	});

	test("a temp knight records the preset it was made from, and none without one", async () => {
		const { model: _model, ...noModel } = WRITER;
		await fx.team.savePreset("coordinator", noModel);
		await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
		await asCoordinator((caller) =>
			fx.team.helperCreate(caller, { preset: "writer", task: "Write it." }),
		);
		await settle();
		expect(fx.store.agent("coordinator-1")?.preset).toBeUndefined();
		expect(fx.store.agent("coordinator-2")?.preset).toBe("writer");
	});
});

describeDb("an owner's presets with helpers off", () => {
	useTeamFixture({ helpers: false });
	test("are refused", async () => {
		expect(fx.team.helpersOn()).toBe(false);
		await expect(fx.team.presets("coordinator")).rejects.toThrow(
			"switched off",
		);
		await expect(fx.team.savePreset("coordinator", WRITER)).rejects.toThrow(
			"switched off",
		);
	});
});
