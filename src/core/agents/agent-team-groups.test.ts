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
import { discordKey, groupSessionKey } from "./team-keys.ts";

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
					{ id, name: `admin ${id}`, tier: "admin" },
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
			await fx.team.channelDeleted(pair.channelId);
			expect(fx.store.group("pair")?.status).toBe("archived");
			expect(fx.runtime.fresh).toEqual([
				groupSessionKey(pair, "infra"),
				groupSessionKey(pair, "doctor"),
			]);
			expect(fx.store.agent("infra")?.status).toBe("active");
			expect(fx.team.owns(discordKey(pair.channelId))).toBeUndefined();
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
			expect(fx.channels.categoryOf(pair.channelId)).toBe("Archive");
			expect(fx.channels.webhooksRemoved).toEqual([pair.channelId]);
			expect(fx.runtime.fresh).toEqual([
				groupSessionKey(pair, "infra"),
				groupSessionKey(pair, "doctor"),
			]);
			expect(fx.team.owns(discordKey(pair.channelId))).toBeUndefined();
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
				discordKey(pair.channelId),
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

		test("a group round shows no stop button", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const pair = fx.store.group("pair");
			if (!pair) throw new Error("no pair group");
			script.scores = { infra: 0.9, doctor: 0.1 };
			await fx.team.answerGroup(
				discordKey(pair.channelId),
				OWNER_SPEAKER,
				"hello all",
				"hello all",
				NO_ATTACHMENTS,
				undefined,
			);
			expect(stops).toEqual([]);
		});
	});
});
