import { describe, expect, test } from "bun:test";
import { AgentError } from "../domain/errors.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	fx,
	removedSchedules,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { agentRoomKey, discordKey } from "./team-keys.ts";

const NOTES = {
	name: "notes",
	displayName: "Notes",
	prompt: "Keep notes.",
};

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("an owner's operations on the team (Discord)", () => {
	useTeamFixture();

	describe("createAgent", () => {
		test("makes the agent outside any turn, with its channel, model, skills and opening task", async () => {
			const agent = await fx.team.createAgent(OWNER_SPEAKER, {
				...NOTES,
				task: "Say hi.",
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
				skills: ["kit-do"],
				character: { class: "scribe" },
			});
			await settle();
			expect(agent.name).toBe("notes");
			expect(fx.store.agent("notes")).toMatchObject({
				displayName: "Notes",
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
				status: "active",
			});
			expect(fx.store.agent("notes")?.character?.class).toBe("scribe");
			expect(fx.skills.carriedNames("notes")).toEqual(["kit-do"]);
			const channel = fx.store.agent("notes")?.channelId ?? "";
			expect(fx.channels.categoryOf(channel)).toBe("Agents");
			// The opening task ran as the owner, who is named as its creator.
			const turn = fx.runtime.turns.find(
				(t) => t.channel === discordKey(channel),
			);
			expect(turn?.text).toContain("You were just created by");
			expect(turn?.text).toContain("Riley");
			expect(turn?.text).toContain("Say hi.");
		});

		test("the opening task runs in the room of the surface that asked, not the Discord channel", async () => {
			fx.surfaces.rooms = ["app"];
			await fx.team.createAgent(OWNER_SPEAKER, {
				...NOTES,
				task: "Say hi.",
				openIn: "app",
			});
			await settle();
			expect(fx.runtime.turns.map((t) => t.channel)).toEqual([
				agentRoomKey("app", "notes"),
			]);
			// A surface that hosts no rooms falls back to the agent's channel.
			await fx.team.createAgent(OWNER_SPEAKER, {
				name: "more",
				displayName: "More",
				prompt: "More.",
				task: "Go.",
				openIn: "elsewhere",
			});
			await settle();
			const channel = fx.store.agent("more")?.channelId ?? "";
			expect(fx.runtime.turns.map((t) => t.channel)).toContain(
				discordKey(channel),
			);
		});

		test("without a task the agent only exists", async () => {
			await fx.team.createAgent(OWNER_SPEAKER, NOTES);
			await settle();
			expect(fx.store.agent("notes")?.status).toBe("active");
			expect(fx.runtime.turns).toHaveLength(0);
		});

		test("refuses a taken name, an unusable model, a bad thinking level and an unknown skill before anything is made", async () => {
			const before = fx.channels.created.length;
			await expect(
				fx.team.createAgent(OWNER_SPEAKER, { ...NOTES, name: "infra" }),
			).rejects.toThrow(AgentError);
			await expect(
				fx.team.createAgent(OWNER_SPEAKER, {
					...NOTES,
					model: "nobody/nothing",
				}),
			).rejects.toThrow(/cannot run/);
			await expect(
				fx.team.createAgent(OWNER_SPEAKER, { ...NOTES, thinking: "deep" }),
			).rejects.toThrow(AgentError);
			await expect(
				fx.team.createAgent(OWNER_SPEAKER, { ...NOTES, skills: ["nope"] }),
			).rejects.toThrow(/Unknown skills/);
			expect(fx.channels.created.length).toBe(before);
			expect(fx.store.agent("notes")).toBeUndefined();
		});
	});

	describe("archive, restore and remove", () => {
		test("an owner archives an agent without a calling agent, and may archive any non-coordinator", async () => {
			const doctor = fx.store.agent("doctor")?.channelId ?? "";
			const said = await fx.team.archive(undefined, "doctor");
			expect(said).toContain("Archive");
			expect(fx.store.agent("doctor")?.status).toBe("archived");
			expect(removedSchedules).toEqual([7]);
			expect(fx.channels.categoryOf(doctor)).toBe("Archive");
			await expect(fx.team.archive(undefined, "coordinator")).rejects.toThrow(
				"The coordinator cannot be archived.",
			);
			await expect(fx.team.archive(undefined, "nobody")).rejects.toThrow(
				/no agent or group/,
			);
		});

		test("restore brings the agent and its channel back, but not into the groups it left", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor", "coordinator"],
				host: "infra",
			});
			const doctor = fx.store.agent("doctor")?.channelId ?? "";
			await fx.team.archive(undefined, "doctor");
			expect(fx.store.group("pair")?.members).toEqual(["infra", "coordinator"]);
			const said = await fx.team.restore("doctor");
			expect(said).toContain("Restored");
			expect(fx.store.agent("doctor")?.status).toBe("active");
			expect(fx.channels.categoryOf(doctor)).toBe("Agents");
			expect(fx.team.owns(discordKey(doctor))).toBe("agent");
			expect(fx.store.group("pair")?.members).not.toContain("doctor");
			await expect(fx.team.restore("doctor")).rejects.toThrow(/not archived/);
			await expect(fx.team.restore("nobody")).rejects.toThrow(AgentError);
		});

		test("restore makes a new channel when the old one was deleted meanwhile", async () => {
			const old = fx.store.agent("doctor")?.channelId ?? "";
			await fx.team.archive(undefined, "doctor");
			fx.channels.deleted.add(old);
			await fx.team.restore("doctor");
			const now = fx.store.agent("doctor")?.channelId ?? "";
			expect(now).not.toBe(old);
			expect(fx.channels.categoryOf(now)).toBe("Agents");
		});

		test("a group restores with its channel when its members are active, and refuses otherwise", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const channel = fx.store.group("pair")?.channelId ?? "";
			await fx.team.archive(undefined, "pair");
			expect(fx.channels.categoryOf(channel)).toBe("Archive");
			await fx.team.restore("pair");
			expect(fx.store.group("pair")?.status).toBe("active");
			expect(fx.channels.categoryOf(channel)).toBe("Groups");
			// Archiving a member takes it out of the group, which then has too few members.
			await fx.team.archive(undefined, "pair");
			await fx.team.archive(undefined, "doctor");
			await expect(fx.team.restore("pair")).rejects.toThrow(AgentError);
			expect(fx.store.group("pair")?.status).toBe("archived");
			expect(fx.channels.categoryOf(channel)).toBe("Archive");
		});

		test("remove deletes only an archived agent, detaches its skills and frees its name", async () => {
			await fx.team.createAgent(OWNER_SPEAKER, {
				...NOTES,
				skills: ["kit-do"],
			});
			await expect(fx.team.remove("notes")).rejects.toThrow(/archive it/);
			await fx.team.archive(undefined, "notes");
			const said = await fx.team.remove("notes");
			expect(said).toContain("Deleted");
			expect(fx.store.agent("notes")).toBeUndefined();
			expect(fx.skills.carriedNames("notes")).toEqual([]);
			expect(fx.team.owns(agentRoomKey("app", "notes"))).toBeUndefined();
			// The name is free again.
			await fx.team.createAgent(OWNER_SPEAKER, NOTES);
			expect(fx.store.agent("notes")?.status).toBe("active");
			await expect(fx.team.remove("nobody")).rejects.toThrow(AgentError);
		});

		test("remove deletes an archived group with its messages", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			await fx.store.appendGroupMessage("pair", {
				author: "infra",
				authorName: "Infra",
				text: "hello",
			});
			await fx.store.appendGroupMessage("pair@app", {
				author: "infra",
				authorName: "Infra",
				text: "in a room",
			});
			await expect(fx.team.remove("pair")).rejects.toThrow(/archive it/);
			await fx.team.archive(undefined, "pair");
			await fx.team.remove("pair");
			expect(fx.store.group("pair")).toBeUndefined();
			expect(await fx.store.recentGroupMessages("pair", 10)).toEqual([]);
			expect(await fx.store.recentGroupMessages("pair@app", 10)).toEqual([]);
			// Another group of a similar name keeps its messages.
			await fx.team.createGroup({
				name: "pair-two",
				displayName: "Pair two",
				members: ["infra", "doctor"],
			});
			await fx.store.appendGroupMessage("pair-two", {
				author: "infra",
				authorName: "Infra",
				text: "kept",
			});
			await fx.team.archive(undefined, "pair-two");
			expect(await fx.store.recentGroupMessages("pair-two", 10)).toHaveLength(
				1,
			);
		});
	});
});

describeDb("an owner's operations on a team without Discord", () => {
	useTeamFixture({ local: true });

	test("a new agent starts its opening task in its room, and restores without a channel", async () => {
		await fx.team.createAgent(OWNER_SPEAKER, { ...NOTES, task: "Say hi." });
		await settle();
		expect(fx.store.agent("notes")?.channelId).toBeUndefined();
		expect(
			fx.runtime.turns.filter(
				(t) => t.channel === agentRoomKey("app", "notes"),
			),
		).toHaveLength(1);
		await fx.team.archive(undefined, "notes");
		expect(fx.team.owns(agentRoomKey("app", "notes"))).toBeUndefined();
		await fx.team.restore("notes");
		expect(fx.team.owns(agentRoomKey("app", "notes"))).toBe("agent");
		expect(fx.channels.created).toEqual([]);
	});
});
