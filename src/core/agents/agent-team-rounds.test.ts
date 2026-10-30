import { beforeEach, describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	fx,
	opsGroup,
	script,
	stops,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { discordKey, groupRoomKey, groupSessionKey } from "./team-keys.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	useTeamFixture();

	describe("a group's round, as the owner sees it and stops it", () => {
		const groupRoom = groupRoomKey("app", "ops");
		let discordGroup: ChannelKey;

		beforeEach(async () => {
			fx.surfaces.rooms = ["app"];
			await fx.team.createGroup({
				name: "ops",
				displayName: "Ops",
				members: ["coordinator", "infra", "doctor"],
			});
			discordGroup = discordKey(fx.store.group("ops")?.channelId ?? "");
		});

		const ask = (channel: ChannelKey, text: string) =>
			fx.team.answerGroup(
				channel,
				OWNER_SPEAKER,
				text,
				text,
				NO_ATTACHMENTS,
				undefined,
			);
		const speakers = () =>
			fx.runtime.turns.map((t) => t.agent?.name).filter(Boolean);
		/** What a round told the surface, one line per step: the state, who speaks, who is next, who has spoken, the count. */
		const told = () =>
			fx.surfaces.rounds.map(({ round }) =>
				[
					round.ended ?? round.state,
					round.current ?? "-",
					`next:${round.next.join("+") || "-"}`,
					`spoken:${round.spoken.join("+") || "-"}`,
					`${round.replies}/${round.limit}`,
				].join(" "),
			);

		test("a round in a room tells the surface the plan, each speaker, and how it ended", async () => {
			script.scores = { coordinator: 0.6, infra: 0.9, doctor: 0.1 };
			await ask(groupRoom, "tell me");
			expect(told()).toEqual([
				"running - next:coordinator+infra spoken:- 0/8",
				"running coordinator next:infra spoken:- 0/8",
				"running - next:infra spoken:coordinator 1/8",
				"running infra next:- spoken:coordinator 1/8",
				"running - next:- spoken:coordinator+infra 2/8",
				"done - next:- spoken:coordinator+infra 2/8",
			]);
			// One round has one id: the owner's line that opened it.
			expect(
				new Set(fx.surfaces.rounds.map(({ round }) => round.id)).size,
			).toBe(1);
			expect(fx.surfaces.rounds.every((one) => one.channel === groupRoom)).toBe(
				true,
			);
		});

		test("a handoff shows in the order, and a round at its limit says so", async () => {
			script.scores = { coordinator: 0.1, infra: 0.9, doctor: 0.1 };
			fx.runtime.reply = (r) =>
				r.agent?.name === "infra" ? "@Doctor your turn" : "@Infra your turn";
			await ask(groupRoom, "begin");
			const steps = told();
			expect(steps).toContain("running - next:doctor spoken:infra 1/8");
			expect(steps.at(-1)).toBe("limit - next:infra spoken:infra+doctor 8/8");
		});

		test("Stop in a room ends the round as stopped, drops the queue, and says so", async () => {
			script.scores = { coordinator: 0.6, infra: 0.9, doctor: 0.7 };
			let sessions: ChannelKey[] | undefined;
			fx.runtime.during = () => {
				if (sessions !== undefined) return;
				sessions = fx.team.stopRound(groupRoom);
				fx.runtime.stopNext = true;
			};
			await ask(groupRoom, "stop me");
			expect(speakers()).toEqual(["coordinator"]);
			// The claim stops the session that runs the turn; the round holds only that one.
			expect(sessions).toEqual([
				groupSessionKey(opsGroup(), "coordinator", groupRoom),
			]);
			expect(told().at(-1)).toBe("stopped - next:- spoken:coordinator 1/8");
			expect(fx.surfaces.texts(groupRoom).at(-1)).toContain("did not speak");
			expect(stops).toEqual([`show ${groupRoom}`, `hide ${groupRoom}`]);
			// Nothing is left running: the next message is a round of its own.
			expect(fx.team.stopRound(groupRoom)).toBeUndefined();
			fx.runtime.during = undefined;
			fx.runtime.turns = [];
			await ask(groupRoom, "again");
			expect(speakers()).toEqual(["coordinator", "doctor", "infra"]);
		});

		test("Stop ends a Discord group's round the same way, and tells no surface", async () => {
			script.scores = { coordinator: 0.6, infra: 0.9, doctor: 0.7 };
			let sessions: ChannelKey[] | undefined;
			fx.runtime.during = () => {
				if (sessions !== undefined) return;
				sessions = fx.team.stopRound(discordGroup);
				fx.runtime.stopNext = true;
			};
			await ask(discordGroup, "everyone, please");
			expect(fx.surfaces.rounds).toEqual([]);
			expect(speakers()).toEqual(["coordinator"]);
			expect(sessions).toEqual([groupSessionKey(opsGroup(), "coordinator")]);
			expect(fx.channels.texts(discordGroup.slice(8))).toEqual([
				"Coordinator: -# Stopped.",
				"Coordinator: -# The round was stopped, so the members still waiting did not speak.",
			]);
			expect(stops).toEqual([`show ${discordGroup}`, `hide ${discordGroup}`]);
		});

		test("a Stop that comes between two turns still keeps the next member from speaking", async () => {
			script.scores = { coordinator: 0.6, infra: 0.9, doctor: 0.1 };
			fx.runtime.during = () => void fx.team.stopRound(discordGroup);
			await ask(discordGroup, "go");
			// The turn that was running finishes its reply; the member after it does not speak.
			expect(speakers()).toEqual(["coordinator"]);
			expect(fx.channels.texts(discordGroup.slice(8)).at(-1)).toContain(
				"did not speak",
			);
		});

		test("a round that no member can run still ends, and a group archived mid-round ends it too", async () => {
			script.scores = { coordinator: 0.6, infra: 0.9, doctor: 0.1 };
			fx.runtime.during = async (request) => {
				if (request.agent?.name === "coordinator")
					await fx.team.archive(undefined, "ops");
			};
			await ask(groupRoom, "archive it");
			expect(told().at(-1)).toStartWith("done - next:-");
			expect(stops).toEqual([`show ${groupRoom}`, `hide ${groupRoom}`]);
		});
	});
});
