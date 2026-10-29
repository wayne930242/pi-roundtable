import { describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
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

		test("agent_create from a turn in a web room starts the new agent's opening task in that surface's room", async () => {
			fx.surfaces.rooms = ["app"];
			const room = agentRoomKey("app", "coordinator");
			let created: Promise<string> | undefined;
			fx.runtime.during = async () => {
				fx.runtime.during = undefined;
				created = fx.team.create(
					{ name: "coordinator", session: room, home: room },
					{ ...NOTES, task: "Say hi." },
				);
				await created;
			};
			await fx.team.answerOwner(
				room,
				OWNER_SPEAKER,
				"make notes",
				"make notes",
				NO_ATTACHMENTS,
			);
			await created;
			await settle();
			const channel = fx.store.agent("notes")?.channelId ?? "";
			const opened = fx.runtime.turns
				.map((t) => t.channel)
				.filter((c) => c !== room);
			expect(opened).toEqual([agentRoomKey("app", "notes")]);
			expect(opened).not.toContain(discordKey(channel));
		});

		test("only an owner may create an agent here, and nothing is made for anyone else", async () => {
			const before = fx.channels.created.length;
			await expect(
				fx.team.createAgent({ ...OWNER_SPEAKER, tier: "member" }, NOTES),
			).rejects.toThrow(/Only an owner/);
			expect(fx.store.agent("notes")).toBeUndefined();
			expect(fx.channels.created.length).toBe(before);
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

	describe("createGroup", () => {
		test("a display name the store would refuse is refused before the channel is made", async () => {
			const before = fx.channels.created.length;
			for (const displayName of ["discord crew", "x".repeat(33)])
				await expect(
					fx.team.createGroup({
						name: "pair",
						displayName,
						members: ["infra", "doctor"],
					}),
				).rejects.toThrow(AgentError);
			expect(fx.channels.created.length).toBe(before);
			expect(fx.store.group("pair")).toBeUndefined();
		});
	});

	describe("editing a group's members", () => {
		test("a member taken out starts its seat over, in the channel and in each room", async () => {
			fx.surfaces.rooms = ["app"];
			await fx.team.createGroup({
				name: "trio",
				displayName: "Trio",
				members: ["infra", "doctor", "coordinator"],
				host: "infra",
			});
			const channel = fx.store.group("trio")?.channelId ?? "";
			fx.runtime.fresh.length = 0;
			await fx.team.updateGroup("trio", { members: ["infra", "coordinator"] });
			expect(fx.runtime.fresh).toEqual([
				`agentgroup:${channel}.doctor`,
				"agentgroup:app.group.trio.doctor",
			]);
			// Changing only the name or the host touches no seat.
			fx.runtime.fresh.length = 0;
			await fx.team.updateGroup("trio", {
				displayName: "Three",
				host: "coordinator",
			});
			expect(fx.runtime.fresh).toEqual([]);
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
			// Archiving a member that leaves too few archives the group whole, members kept.
			await fx.team.archive(undefined, "pair");
			await fx.team.archive(undefined, "doctor");
			await expect(fx.team.restore("pair")).rejects.toThrow(AgentError);
			expect(fx.store.group("pair")?.status).toBe("archived");
			expect(fx.channels.categoryOf(channel)).toBe("Archive");
		});

		test("a group archived because a member was archived restores once that member does", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
				host: "doctor",
			});
			await fx.team.archive(undefined, "doctor");
			// The group is archived with both members, not left with one.
			expect(fx.store.group("pair")).toMatchObject({
				status: "archived",
				members: ["infra", "doctor"],
				host: "doctor",
			});
			await expect(fx.team.restore("pair")).rejects.toThrow(AgentError);
			await fx.team.restore("doctor");
			await fx.team.restore("pair");
			expect(fx.store.group("pair")).toMatchObject({
				status: "active",
				members: ["infra", "doctor"],
			});
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

		test("remove runs a surface's cleanup after its checks, and a cleanup that throws deletes nothing", async () => {
			await fx.team.createAgent(OWNER_SPEAKER, NOTES);
			let ran = 0;
			const cleanup = async () => {
				ran += 1;
			};
			// Refused before the cleanup: an active agent and an unknown one.
			await expect(fx.team.remove("notes", cleanup)).rejects.toThrow(
				/archive it/,
			);
			await expect(fx.team.remove("nobody", cleanup)).rejects.toThrow(
				AgentError,
			);
			expect(ran).toBe(0);
			await fx.team.archive(undefined, "notes");
			await expect(
				fx.team.remove("notes", async () => {
					throw new Error("the app's database is gone");
				}),
			).rejects.toThrow(/database is gone/);
			expect(fx.store.agent("notes")?.status).toBe("archived");
			await fx.team.remove("notes", cleanup);
			expect(ran).toBe(1);
			expect(fx.store.agent("notes")).toBeUndefined();
		});

		test("remove makes the runtime forget an agent's conversations, its own and its seats in every group", async () => {
			fx.surfaces.rooms = ["app"];
			await fx.team.createAgent(OWNER_SPEAKER, NOTES);
			await fx.team.createGroup({
				name: "trio",
				displayName: "Trio",
				members: ["notes", "infra", "doctor"],
			});
			const channel = fx.store.agent("notes")?.channelId ?? "";
			const groupChannel = fx.store.group("trio")?.channelId ?? "";
			await fx.team.archive(undefined, "notes");
			expect(fx.runtime.deleted).toEqual([]);
			await fx.team.remove("notes");
			expect(fx.runtime.deleted).toEqual([
				discordKey(channel),
				agentRoomKey("app", "notes"),
				`agentgroup:${groupChannel}.notes`,
				"agentgroup:app.group.trio.notes",
			]);
		});

		test("remove makes the runtime forget a group's seats of every member", async () => {
			fx.surfaces.rooms = ["app"];
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const channel = fx.store.group("pair")?.channelId ?? "";
			await fx.team.archive(undefined, "pair");
			await fx.team.remove("pair");
			expect(fx.runtime.deleted).toEqual([
				discordKey(channel),
				"app:group.pair",
				`agentgroup:${channel}.infra`,
				"agentgroup:app.group.pair.infra",
				`agentgroup:${channel}.doctor`,
				"agentgroup:app.group.pair.doctor",
			]);
		});

		test("remove refuses an agent the configuration seeds, which the next start would seed again", async () => {
			await fx.team.archive(undefined, "doctor");
			await expect(fx.team.remove("doctor")).rejects.toThrow(
				/Remove it from the configuration first/,
			);
			expect(fx.store.agent("doctor")?.status).toBe("archived");
			// Active or not, the refusal is about where the agent comes from.
			await expect(fx.team.remove("infra")).rejects.toThrow(/configuration/);
			expect(fx.store.agent("infra")?.status).toBe("active");
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
