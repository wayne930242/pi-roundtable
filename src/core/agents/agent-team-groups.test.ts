import { beforeEach, describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	agentChannel,
	ENTRY,
	fx,
	opsGroup,
	removedSchedules,
	script,
	settle,
	stops,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import {
	agentRoomKey,
	discordKey,
	groupRoomKey,
	groupSessionKey,
} from "./team-keys.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	useTeamFixture();

	describe("groups", () => {
		let group: ChannelKey;

		beforeEach(async () => {
			const answer = await fx.team.createGroup({
				name: "ops",
				displayName: "Ops",
				members: ["coordinator", "infra", "doctor"],
			});
			expect(answer).toContain("host coordinator");
			group = discordKey(fx.store.group("ops")?.channelId ?? "");
		});

		const round = (text: string, repliedTo?: string) =>
			fx.team.answerGroup(
				group,
				OWNER_SPEAKER,
				text,
				text,
				NO_ATTACHMENTS,
				repliedTo,
			);
		const speakers = () =>
			fx.runtime.turns.map((t) => t.agent?.name).filter(Boolean);

		test("the group channel's topic names the members and host, and follows changes", async () => {
			const id = fx.store.group("ops")?.channelId ?? "";
			expect(fx.channels.topics.get(id)).toBe(
				"Ops | Members: Coordinator, Infra, Doctor | Host: Coordinator",
			);
			await fx.team.updateGroup("ops", { members: ["coordinator", "infra"] });
			expect(fx.channels.topics.get(id)).toBe(
				"Ops | Members: Coordinator, Infra | Host: Coordinator",
			);
			await fx.team.update("infra", { displayName: "Ops team" });
			expect(fx.channels.topics.get(id)).toBe(
				"Ops | Members: Coordinator, Ops team | Host: Coordinator",
			);
		});

		test("members above 0.5 speak one at a time, most relevant last", async () => {
			script.scores = { coordinator: 0.6, infra: 0.9, doctor: 0.1 };
			await round("memory is tight");
			expect(speakers()).toEqual(["coordinator", "infra"]);
			// The owner started the round, so every speaker may ask him on cards.
			expect(fx.runtime.turns.map((t) => t.interactive)).toEqual([true, true]);
			expect(fx.runtime.turns[0]?.agent?.session).toBe(
				groupSessionKey(opsGroup(), "coordinator"),
			);
			// The later speaker sees the earlier reply.
			expect(fx.runtime.turns[1]?.text).toContain(
				"[Coordinator] coordinator ok",
			);
			expect(fx.runtime.turns[1]?.text).toContain(
				"You are Infra, and it is your turn",
			);
		});

		test("a mentioned member speaks whatever its score; replying to one counts too", async () => {
			script.scores = { coordinator: 0.1, infra: 0.9, doctor: 0.05 };
			await round("@Doctor what do you think");
			expect(speakers()).toEqual(["doctor", "infra"]);
			fx.runtime.turns = [];
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.1 };
			await round("and this one", "Infra");
			expect(speakers()).toEqual(["infra"]);
		});

		test("with nobody relevant the host answers; without a judge only mentions answer", async () => {
			script.scores = { coordinator: 0.1, infra: 0.2, doctor: 0.3 };
			await round("good morning");
			expect(speakers()).toEqual(["coordinator"]);
			fx.runtime.turns = [];
			script.scores = undefined;
			await round("@infra are you there");
			expect(speakers()).toEqual(["infra"]);
		});

		test("every message reaches every member once, even after silent rounds", async () => {
			script.scores = { coordinator: 0.1, infra: 0.9, doctor: 0.1 };
			await round("first message");
			await round("second message");
			fx.runtime.turns = [];
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.9 };
			await round("third message");
			const doctor = fx.runtime.turns[0]?.text ?? "";
			for (const text of [
				"first message",
				"second message",
				"third message",
				"infra ok",
			])
				expect(doctor).toContain(text);
			fx.runtime.turns = [];
			await round("fourth message");
			const again = fx.runtime.turns[0]?.text ?? "";
			expect(again).toContain("fourth message");
			expect(again).not.toContain("third message");
			expect(again).not.toContain("doctor ok");
		});

		test("a mention in a reply hands off; a round stops at 8 replies", async () => {
			script.scores = { coordinator: 0.1, infra: 0.9, doctor: 0.1 };
			fx.runtime.reply = (r) =>
				r.agent?.name === "infra" ? "@Doctor your turn" : "@Infra your turn";
			await round("begin");
			expect(speakers()).toHaveLength(8);
			expect(speakers().slice(0, 3)).toEqual(["infra", "doctor", "infra"]);
			expect(fx.channels.texts(group.slice(8)).at(-1)).toContain(
				"already has 8 replies",
			);
		});

		test("a member with held actions is asked, and a confirming message approves them", async () => {
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.1 };
			fx.runtime.held.set(groupSessionKey(opsGroup(), "infra"), {
				selectionId: "agent",
				heldAt: new Date(),
				calls: [{ tool: "bash", input: "{}", action: "restart" }],
			});
			await round("yes, restart it");
			expect(speakers()).toEqual(["infra"]);
			expect(fx.runtime.turns[0]?.confirmed).toBe(true);
		});

		test("only the speaker whose round held a member's actions, or the owner, approves them", async () => {
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.1 };
			const held = {
				selectionId: "agent",
				heldAt: new Date(),
				calls: [{ tool: "deploy", input: "{}", action: "deploy the site" }],
				speakerId: "7",
			};
			fx.runtime.held.set(groupSessionKey(opsGroup(), "infra"), held);
			const say = (id: string) =>
				fx.team.answerGroup(
					group,
					{ id, name: `admin ${id}`, tier: "admin", principalId: id },
					"yes, do it",
					"yes, do it",
					NO_ATTACHMENTS,
					undefined,
				);
			await say("8");
			expect(fx.runtime.turns.map((t) => t.confirmed)).toEqual([undefined]);
			fx.runtime.turns = [];
			await say("7");
			expect(speakers()).toEqual(["infra"]);
			expect(fx.runtime.turns[0]?.confirmed).toBe(true);
		});

		test("a held call is its principal's: the same person on another identity approves it, another principal of the same tier does not", async () => {
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.1 };
			fx.runtime.held.set(groupSessionKey(opsGroup(), "infra"), {
				selectionId: "agent",
				heldAt: new Date(),
				calls: [{ tool: "deploy", input: "{}", action: "deploy the site" }],
				speakerId: "7",
				principalId: "p_ada",
			});
			const say = (id: string, principalId: string) =>
				fx.team.answerGroup(
					group,
					{ id, name: `admin ${id}`, tier: "admin", principalId },
					"yes, do it",
					"yes, do it",
					NO_ATTACHMENTS,
					undefined,
				);
			// The same surface id under another principal, as after an unlink and a new link, is not them.
			await say("7", "p_bob");
			expect(fx.runtime.turns.map((t) => t.confirmed)).toEqual([undefined]);
			fx.runtime.turns = [];
			await say("8", "p_ada");
			expect(speakers()).toEqual(["infra"]);
			expect(fx.runtime.turns[0]?.confirmed).toBe(true);
		});

		test("held actions 0.8 held over another's after a rollback are its speaker's: the principal of the hold before approves nothing", async () => {
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.1 };
			// What PendingConfirmationStore.load gives for that row: B's, by their id alone.
			fx.runtime.held.set(groupSessionKey(opsGroup(), "infra"), {
				selectionId: "agent",
				heldAt: new Date(),
				calls: [{ tool: "deploy", input: "{}", action: "deploy the site" }],
				speakerId: "B",
			});
			const say = (id: string, principalId: string) =>
				fx.team.answerGroup(
					group,
					{ id, name: `admin ${id}`, tier: "admin", principalId },
					"yes, do it",
					"yes, do it",
					NO_ATTACHMENTS,
					undefined,
				);
			await say("A", "pA");
			expect(fx.runtime.turns.map((t) => t.confirmed)).toEqual([undefined]);
			fx.runtime.turns = [];
			await say("B", "pB");
			expect(speakers()).toEqual(["infra"]);
			expect(fx.runtime.turns[0]?.confirmed).toBe(true);
		});
	});

	describe("archive", () => {
		const coordinator = {
			name: "coordinator",
			session: discordKey(ENTRY),
			home: discordKey(ENTRY),
		};

		test("deleting an agent's channel archives it, cancels schedules, and leaves groups", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
				host: "infra",
			});
			const doctorChannel = fx.store.agent("doctor")?.channelId ?? "";
			expect(doctorChannel).toBe("2000");
			await fx.team.channelDeleted(doctorChannel);
			expect(fx.store.agent("doctor")?.status).toBe("archived");
			expect(removedSchedules).toEqual([7]);
			expect(fx.runtime.fresh).toContain(discordKey(doctorChannel));
			expect(fx.store.group("pair")?.status).toBe("archived");
			expect(fx.team.owns(discordKey(doctorChannel))).toBeUndefined();
			expect(() =>
				fx.team.message(
					{ name: "infra", session: "discord:x", home: "discord:x" },
					"doctor",
					"hi",
				),
			).toThrow(/archived/);
		});

		test("startup writes each active group's topic", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const id = fx.store.group("pair")?.channelId ?? "";
			fx.channels.topics.set(id, "Group: Pair");
			await fx.team.start();
			expect(fx.channels.topics.get(id)).toBe(
				"Pair | Members: Infra, Doctor | Host: Infra",
			);
		});

		test("deleting a group's channel archives it and resets its members' group conversations", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const pair = fx.store.group("pair");
			if (!pair) throw new Error("no pair group");
			await fx.team.channelDeleted(pair.channelId ?? "");
			expect(fx.store.group("pair")?.status).toBe("archived");
			expect(fx.runtime.fresh).toEqual([
				groupSessionKey(pair, "infra"),
				groupSessionKey(pair, "doctor"),
			]);
			expect(fx.store.agent("infra")?.status).toBe("active");
			expect(fx.team.owns(discordKey(pair.channelId ?? ""))).toBeUndefined();
		});

		test("the archive tool archives a group and keeps its channel under Archive", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const pair = fx.store.group("pair");
			if (!pair) throw new Error("no pair group");
			const said = await fx.team.archive(coordinator, "pair");
			expect(said).toContain("Archive");
			expect(fx.store.group("pair")?.status).toBe("archived");
			expect(fx.channels.categoryOf(pair.channelId ?? "")).toBe("Archive");
			expect(fx.channels.webhooksRemoved).toEqual([pair.channelId ?? ""]);
			expect(fx.runtime.fresh).toEqual([
				groupSessionKey(pair, "infra"),
				groupSessionKey(pair, "doctor"),
			]);
			expect(fx.team.owns(discordKey(pair.channelId ?? ""))).toBeUndefined();
			await expect(fx.team.archive(coordinator, "pair")).rejects.toThrow(
				/already archived/,
			);
		});

		test("the archive tool archives an agent like a deleted channel", async () => {
			const doctorChannel = fx.store.agent("doctor")?.channelId ?? "";
			await fx.team.archive(coordinator, "doctor");
			expect(fx.store.agent("doctor")?.status).toBe("archived");
			expect(removedSchedules).toEqual([7]);
			expect(fx.channels.categoryOf(doctorChannel)).toBe("Archive");
		});

		test("the archive tool refuses the coordinator, the caller, and unknown names", async () => {
			const infra = {
				name: "infra",
				session: agentChannel("infra"),
				home: agentChannel("infra"),
			};
			await expect(fx.team.archive(infra, "coordinator")).rejects.toThrow(
				/coordinator/,
			);
			await expect(fx.team.archive(infra, "infra")).rejects.toThrow(/yourself/);
			await expect(fx.team.archive(infra, "nobody")).rejects.toThrow(
				/agent_list/,
			);
			expect(fx.store.agent("infra")?.status).toBe("active");
		});

		test("a round stops when a member archives its group", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const pair = fx.store.group("pair");
			if (!pair) throw new Error("no pair group");
			script.scores = { infra: 0.9, doctor: 0.9 };
			fx.runtime.during = (request) => {
				if (request.agent?.name === "infra")
					return fx.team.archive(request.agent, "pair");
			};
			await fx.team.answerGroup(
				discordKey(pair.channelId ?? ""),
				OWNER_SPEAKER,
				"close this group",
				"close this group",
				NO_ATTACHMENTS,
				undefined,
			);
			expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual(["infra"]);
			expect(fx.store.group("pair")?.status).toBe("archived");
		});

		test("a reply finishing after its agent was archived is not posted", async () => {
			const doctorChannel = fx.store.agent("doctor")?.channelId ?? "";
			fx.runtime.during = (request) => {
				if (request.agent?.name === "doctor")
					return fx.team.archive(coordinator, "doctor");
			};
			await fx.team.answerOwner(
				agentChannel("doctor"),
				OWNER_SPEAKER,
				"look into it",
				"look into it",
				NO_ATTACHMENTS,
			);
			expect(fx.store.agent("doctor")?.status).toBe("archived");
			expect(fx.channels.texts(doctorChannel)).toEqual([]);
		});

		test("a channel deleted while the bot was down is archived at startup", async () => {
			fx.channels.deleted.add(fx.store.agent("infra")?.channelId ?? "");
			await fx.team.start();
			expect(fx.store.agent("infra")?.status).toBe("archived");
		});
	});

	describe("stop and steer", () => {
		test("an owner turn in an agent's channel is steerable and shows the stop button", async () => {
			await fx.team.answerOwner(
				agentChannel("infra"),
				OWNER_SPEAKER,
				"look into it",
				"look into it",
				NO_ATTACHMENTS,
			);
			expect(fx.runtime.turns[0]?.steerable).toBe(true);
			expect(fx.runtime.turns[0]?.interactive).toBe(true);
			expect(stops).toEqual([
				`show ${agentChannel("infra")}`,
				`hide ${agentChannel("infra")}`,
			]);
		});

		test("a turn for another agent's message is not steerable", async () => {
			// Only infra's first turn asks; its follow-up must not ask again.
			let asked = false;
			fx.runtime.during = (request) => {
				if (request.agent?.name === "infra" && !asked) {
					asked = true;
					fx.team.message(request.agent, "doctor", "read the log for me");
				}
			};
			await fx.team.answerOwner(
				agentChannel("infra"),
				OWNER_SPEAKER,
				"ask the doctor",
				"ask the doctor",
				NO_ATTACHMENTS,
			);
			for (let i = 0; i < 5; i++) await settle();
			const doctor = fx.runtime.turns.find((t) => t.agent?.name === "doctor");
			expect(doctor?.steerable).toBeUndefined();
			expect(doctor?.interactive).toBeUndefined();
			// The answer's follow-up is a report back to infra, so it may ask on cards.
			const followUp = fx.runtime.turns.filter(
				(t) => t.agent?.name === "infra",
			);
			expect(followUp.map((t) => t.interactive)).toEqual([true, true]);
			expect(followUp[1]?.steerable).toBeUndefined();
		});

		test("a stopped turn posts the stopped notice", async () => {
			fx.runtime.stopNext = true;
			await fx.team.answerOwner(
				agentChannel("infra"),
				OWNER_SPEAKER,
				"runs long",
				"runs long",
				NO_ATTACHMENTS,
			);
			expect(
				fx.channels.texts(fx.store.agent("infra")?.channelId ?? ""),
			).toEqual(["Infra: -# Stopped."]);
		});

		test("a group round shows the stop button until the round ends", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const pair = fx.store.group("pair");
			if (!pair) throw new Error("no pair group");
			script.scores = { infra: 0.9, doctor: 0.1 };
			const pairChannel = discordKey(pair.channelId ?? "");
			await fx.team.answerGroup(
				pairChannel,
				OWNER_SPEAKER,
				"hello all",
				"hello all",
				NO_ATTACHMENTS,
				undefined,
			);
			expect(stops).toEqual([`show ${pairChannel}`, `hide ${pairChannel}`]);
		});
	});

	describe("rooms", () => {
		const agentRoom = (name: string) => agentRoomKey("app", name);
		const groupRoom = groupRoomKey("app", "g");
		let discordGroup: ChannelKey;

		beforeEach(async () => {
			fx.surfaces.rooms = ["app"];
			await fx.team.createGroup({
				name: "g",
				displayName: "G",
				members: ["coordinator", "infra", "doctor"],
			});
			discordGroup = discordKey(fx.store.group("g")?.channelId ?? "");
			script.scores = { coordinator: 0.1, infra: 0.9, doctor: 0.1 };
		});

		const group = () => {
			const found = fx.store.group("g");
			if (!found) throw new Error("no group g");
			return found;
		};
		const inRoom = (text: string) =>
			fx.team.answerGroup(
				groupRoom,
				OWNER_SPEAKER,
				text,
				text,
				NO_ATTACHMENTS,
				undefined,
			);
		const inDiscord = (text: string) =>
			fx.team.answerGroup(
				discordGroup,
				OWNER_SPEAKER,
				text,
				text,
				NO_ATTACHMENTS,
				undefined,
			);

		test("a round in a group's room logs under group@surface, runs the room's seats, and replies through the surface", async () => {
			await inRoom("from the web");
			const turn = fx.runtime.turns[0];
			expect(turn?.channel).toBe(groupRoom);
			expect(turn?.agent).toEqual({
				name: "infra",
				session: "agentgroup:app.group.g.infra",
				home: agentRoom("infra"),
				group: "g",
			});
			expect(
				(await fx.store.recentGroupMessages("g@app", 10)).map((m) => m.text),
			).toEqual(["from the web", "infra ok"]);
			// The Discord conversation of the same group is untouched.
			expect(await fx.store.recentGroupMessages("g", 10)).toEqual([]);
			expect(fx.surfaces.texts(groupRoom)).toEqual(["infra: infra ok"]);
			expect(fx.channels.posts).toEqual([]);
		});

		test("the room and the Discord channel keep separate seats, logs and cursors", async () => {
			await inRoom("web one");
			fx.runtime.turns = [];
			await inDiscord("discord one");
			const turn = fx.runtime.turns[0];
			expect(turn?.agent?.session).toBe(groupSessionKey(group(), "infra"));
			// The Discord seat has not seen what was said in the room.
			expect(turn?.text).toContain("discord one");
			expect(turn?.text).not.toContain("web one");
			expect(
				(await fx.store.recentGroupMessages("g", 10)).map((m) => m.text),
			).toEqual(["discord one", "infra ok"]);
			expect(fx.channels.texts(discordGroup.slice(8))).toEqual([
				"Infra: infra ok",
			]);
			expect(fx.surfaces.texts(groupRoom)).toEqual(["infra: infra ok"]);
		});

		test("held actions of a room's seat are the room's: a confirming message there approves them", async () => {
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.1 };
			fx.runtime.held.set("agentgroup:app.group.g.infra", {
				selectionId: "agent",
				heldAt: new Date(),
				calls: [{ tool: "bash", input: "{}", action: "restart" }],
			});
			await inRoom("yes, restart it");
			expect(fx.runtime.turns[0]?.confirmed).toBe(true);
			// The Discord seat held nothing, so the same words there approve nothing.
			fx.runtime.turns = [];
			await inDiscord("yes, restart it");
			expect(fx.runtime.turns.map((t) => t.confirmed)).toEqual([undefined]);
		});

		test("starting a room over resets its seats and log cursor only", async () => {
			await inRoom("one");
			await inDiscord("one");
			fx.runtime.fresh = [];
			await fx.team.startFresh(groupRoom);
			expect(fx.runtime.fresh).toEqual([
				"agentgroup:app.group.g.coordinator",
				"agentgroup:app.group.g.infra",
				"agentgroup:app.group.g.doctor",
			]);
			fx.runtime.turns = [];
			await inRoom("two");
			expect(fx.runtime.turns[0]?.text).not.toContain("one");
			// A Discord round still sees what it had not yet.
			expect(groupSessionKey(group(), "infra")).not.toBe(
				fx.runtime.turns[0]?.agent?.session,
			);
		});

		test("an agent's room is its own conversation beside its Discord channel", async () => {
			await fx.team.answerOwner(
				agentRoom("doctor"),
				OWNER_SPEAKER,
				"hi",
				"hi",
				NO_ATTACHMENTS,
			);
			const turn = fx.runtime.turns[0];
			expect(turn?.agent?.session).toBe(agentRoom("doctor"));
			expect(turn?.channel).toBe(agentRoom("doctor"));
			expect(fx.surfaces.texts(agentRoom("doctor"))).toEqual([
				"doctor: doctor ok",
			]);
			expect(fx.channels.posts).toEqual([]);
			// A room of an agent the team does not know, or of a surface that hosts none, is refused.
			await expect(
				fx.team.answerOwner(
					agentRoom("nobody"),
					OWNER_SPEAKER,
					"hi",
					"hi",
					NO_ATTACHMENTS,
				),
			).rejects.toThrow(/no agent owns/);
			await expect(
				fx.team.answerOwner(
					agentRoomKey("other", "doctor"),
					OWNER_SPEAKER,
					"hi",
					"hi",
					NO_ATTACHMENTS,
				),
			).rejects.toThrow(/no agent owns/);
		});

		test("the dashboard links no channel for a turn in a room", async () => {
			let during: Awaited<ReturnType<typeof fx.team.status>> | undefined;
			fx.runtime.during = async () => {
				fx.runtime.during = undefined;
				during = await fx.team.status();
			};
			await fx.team.answerOwner(
				agentRoom("doctor"),
				OWNER_SPEAKER,
				"hi",
				"hi",
				NO_ATTACHMENTS,
			);
			const doctor = during?.agents.find((a) => a.name === "doctor");
			expect(doctor).toBeDefined();
			expect(doctor?.workingIn).toBeUndefined();
		});

		test("the team names its coordinator and every key of an agent or group", () => {
			expect(fx.team.coordinator()).toBe("coordinator");
			expect(fx.team.roomsOf("doctor")).toEqual([
				discordKey("2000"),
				agentRoom("doctor"),
			]);
			expect(fx.team.roomsOf("g")).toEqual([discordGroup, groupRoom]);
			expect(fx.team.roomsOf("nobody")).toEqual([]);
			fx.surfaces.rooms = [];
			expect(fx.team.roomsOf("doctor")).toEqual([discordKey("2000")]);
		});

		test("the team owns a room by name and only while the agent or group is active", async () => {
			expect(fx.team.owns(agentRoom("doctor"))).toBe("agent");
			expect(fx.team.owns(groupRoom)).toBe("group");
			expect(fx.team.owns(agentRoom("nobody"))).toBeUndefined();
			expect(fx.team.owns(agentRoomKey("other", "doctor"))).toBeUndefined();
			await fx.team.channelDeleted(fx.store.agent("doctor")?.channelId ?? "");
			expect(fx.team.owns(agentRoom("doctor"))).toBeUndefined();
			// The group stays while it has members left.
			expect(fx.team.owns(groupRoom)).toBe("group");
			await fx.team.channelDeleted(group().channelId ?? "");
			expect(fx.team.owns(groupRoom)).toBeUndefined();
		});

		test("archiving an agent clears the schedules and sessions of every one of its rooms", async () => {
			await fx.team.channelDeleted(fx.store.agent("doctor")?.channelId ?? "");
			expect(removedSchedules.toSorted()).toEqual([7, 8]);
			expect(fx.runtime.fresh).toContain(discordKey("2000"));
			expect(fx.runtime.fresh).toContain(agentRoom("doctor"));
			// Its seats in groups, Discord's and the room's.
			expect(fx.runtime.fresh).toContain("agentgroup:app.group.g.doctor");
			expect(fx.runtime.fresh).toContain(groupSessionKey(group(), "doctor"));
		});

		test("archiving a group clears the seats of every one of its conversations", async () => {
			await fx.team.channelDeleted(group().channelId ?? "");
			expect(fx.store.group("g")?.status).toBe("archived");
			for (const member of ["coordinator", "infra", "doctor"]) {
				expect(fx.runtime.fresh).toContain(groupSessionKey(group(), member));
				expect(fx.runtime.fresh).toContain(`agentgroup:app.group.g.${member}`);
			}
		});

		test("a room's turn is posted nowhere after its agent was archived", async () => {
			fx.runtime.during = async () => {
				fx.runtime.during = undefined;
				await fx.team.channelDeleted(fx.store.agent("doctor")?.channelId ?? "");
			};
			await fx.team.answerOwner(
				agentRoom("doctor"),
				OWNER_SPEAKER,
				"hi",
				"hi",
				NO_ATTACHMENTS,
			);
			expect(fx.surfaces.replies).toEqual([]);
		});
	});
});
