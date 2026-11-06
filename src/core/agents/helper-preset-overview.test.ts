import { expect, test } from "bun:test";
import { describeDb } from "../testing/database.ts";
import { fx, useTeamFixture } from "./agent-team-fixture.ts";
import type { HelperPreset } from "./helper-presets.ts";
import { inTurn, settle } from "./helper-test-kit.ts";

const WRITER: HelperPreset = {
	name: "writer",
	displayName: "Writer",
	prompt: "You write the blog post from the outline you are given.",
	skills: [],
};

const recruit = (agent: string, preset: string) =>
	inTurn(agent, (caller) =>
		fx.team.helperCreate(caller, { preset, task: "Write it." }),
	);

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("every knight's presets", () => {
	useTeamFixture();

	test("lists each preset with its sharing and its recruits by knight and status", async () => {
		await fx.team.savePreset("coordinator", WRITER, "all");
		await fx.team.savePreset("doctor", { ...WRITER, name: "medic" }, ["infra"]);
		await recruit("coordinator", "writer");
		await recruit("coordinator", "writer");
		await recruit("infra", "coordinator/writer");
		await settle();
		await fx.team.archiveHelpers(["coordinator-1"], "test");
		const all = await fx.team.allPresets();
		expect(all.map((p) => `${p.agent}/${p.name}`)).toEqual([
			"coordinator/writer",
			"doctor/medic",
		]);
		const [writer, medic] = all;
		expect(writer?.sharedWith).toBe("all");
		expect(writer?.recruits.map(({ last: _last, ...rest }) => rest)).toEqual([
			{ knight: "coordinator", active: 1, archived: 1 },
			{ knight: "infra", active: 1, archived: 0 },
		]);
		expect(Date.parse(writer?.recruits[0]?.last ?? "")).toBeGreaterThan(0);
		expect(medic?.sharedWith).toEqual(["infra"]);
		expect(medic?.recruits).toEqual([]);
	});

	test("leaves out the presets of an archived knight", async () => {
		await fx.team.savePreset("doctor", WRITER);
		await fx.team.archive(undefined, "doctor");
		await settle();
		expect(await fx.team.allPresets()).toEqual([]);
	});

	test("a transfer keeps content, adds the old owner, drops the new, and leaves past records", async () => {
		await fx.team.savePreset("coordinator", WRITER, ["infra", "doctor"]);
		await recruit("coordinator", "writer");
		await settle();
		const moved = await fx.team.transferPreset(
			"coordinator",
			"writer",
			"infra",
		);
		expect(moved).toEqual({ ...WRITER, sharedWith: ["doctor", "coordinator"] });
		expect(await fx.team.presets("coordinator")).toEqual([]);
		expect(fx.store.agent("coordinator-1")?.preset).toBe("writer");
		// Shared with none, the old owner is the only one left to share with.
		await fx.team.savePreset("doctor", { ...WRITER, name: "medic" });
		const medic = await fx.team.transferPreset("doctor", "medic", "infra");
		expect(medic.sharedWith).toEqual(["doctor"]);
		await fx.team.savePreset("doctor", { ...WRITER, name: "open" }, "all");
		const open = await fx.team.transferPreset("doctor", "open", "infra");
		expect(open.sharedWith).toBe("all");
	});

	test("a transfer refuses the same knight, a taken name, a full knight, and an unknown preset", async () => {
		await fx.team.savePreset("coordinator", WRITER);
		await expect(
			fx.team.transferPreset("coordinator", "writer", "coordinator"),
		).rejects.toThrow("already coordinator's");
		await expect(
			fx.team.transferPreset("coordinator", "nope", "infra"),
		).rejects.toThrow('no preset "nope"');
		await expect(
			fx.team.transferPreset("coordinator", "writer", "nobody"),
		).rejects.toThrow('no agent "nobody"');
		await fx.team.savePreset("infra", WRITER);
		await expect(
			fx.team.transferPreset("coordinator", "writer", "infra"),
		).rejects.toThrow('already has a preset "writer"');
		for (let n = 0; n < 20; n += 1)
			await fx.store.presets.set("doctor", { ...WRITER, name: `p-${n}` });
		await expect(
			fx.team.transferPreset("coordinator", "writer", "doctor"),
		).rejects.toThrow("20 presets");
	});

	test("a transfer and a save racing for the last place leave the cap held", async () => {
		for (let n = 0; n < 19; n += 1)
			await fx.store.presets.set("doctor", { ...WRITER, name: `p-${n}` });
		await fx.team.savePreset("coordinator", WRITER);
		const results = await Promise.allSettled([
			fx.team.transferPreset("coordinator", "writer", "doctor"),
			fx.team.savePreset("doctor", { ...WRITER, name: "last" }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(await fx.team.presets("doctor")).toHaveLength(20);
	});
});

describeDb("every knight's presets with helpers off", () => {
	useTeamFixture({ helpers: false });
	test("are refused", async () => {
		await expect(fx.team.allPresets()).rejects.toThrow("switched off");
		await expect(
			fx.team.transferPreset("coordinator", "writer", "infra"),
		).rejects.toThrow("switched off");
	});
});
