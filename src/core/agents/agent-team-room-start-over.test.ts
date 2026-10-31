import { beforeEach, describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { fx, script, useTeamFixture } from "./agent-team-fixture.ts";
import { discordKey, groupRoomKey, groupSessionKey } from "./team-keys.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	useTeamFixture();

	// A group's room and its Discord channel are two conversations: each starts over alone.
	describe("starting a group's room over", () => {
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
		const say = (channel: ChannelKey, text: string) =>
			fx.team.answerGroup(
				channel,
				OWNER_SPEAKER,
				text,
				text,
				NO_ATTACHMENTS,
				undefined,
			);

		test("catches up the room's log: a member who never spoke there sees nothing older", async () => {
			await say(groupRoom, "before the restart");
			await fx.team.startFresh(groupRoom);
			script.scores = { coordinator: 0.1, infra: 0.1, doctor: 0.9 };
			fx.runtime.turns = [];
			await say(groupRoom, "after the restart");
			const turn = fx.runtime.turns.find((t) => t.agent?.name === "doctor");
			expect(turn?.agent?.session).toBe("agentgroup:app.group.g.doctor");
			expect(turn?.text).toContain("after the restart");
			expect(turn?.text).not.toContain("before the restart");
		});

		test("starting the Discord channel over resets its seats only, never the room's", async () => {
			await say(groupRoom, "one");
			await say(discordGroup, "one");
			fx.runtime.fresh = [];
			await fx.team.startFresh(discordGroup);
			expect(fx.runtime.fresh).toEqual([
				groupSessionKey(group(), "coordinator"),
				groupSessionKey(group(), "infra"),
				groupSessionKey(group(), "doctor"),
			]);
		});
	});
});
