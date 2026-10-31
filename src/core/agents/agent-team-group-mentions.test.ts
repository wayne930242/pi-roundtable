import { beforeEach, describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { fx, opsGroup, script, useTeamFixture } from "./agent-team-fixture.ts";
import { discordKey, groupSessionKey } from "./team-keys.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	useTeamFixture();

	describe("a group message that names members", () => {
		let group: ChannelKey;

		beforeEach(async () => {
			await fx.team.createGroup({
				name: "ops",
				displayName: "Ops",
				members: ["coordinator", "infra", "doctor"],
			});
			group = discordKey(fx.store.group("ops")?.channelId ?? "");
		});

		const round = (text: string) =>
			fx.team.answerGroup(
				group,
				OWNER_SPEAKER,
				text,
				text,
				NO_ATTACHMENTS,
				undefined,
			);
		const speakers = () =>
			fx.runtime.turns.map((t) => t.agent?.name).filter(Boolean);

		test("only the named members answer, in group order, whatever everyone scores", async () => {
			script.scores = { coordinator: 0.9, infra: 0.95, doctor: 0.9 };
			await round("@Doctor and @Coordinator, what do you think");
			expect(speakers()).toEqual(["coordinator", "doctor"]);
		});

		test("a message that names no one is scored and planned as before", async () => {
			script.scores = { coordinator: 0.1, infra: 0.9, doctor: 0.7 };
			await round("what do you think");
			expect(speakers()).toEqual(["doctor", "infra"]);
			fx.runtime.turns = [];
			await round("@Coordinator first");
			expect(speakers()).toEqual(["coordinator"]);
		});

		test("a named member's reply that mentions another still hands off", async () => {
			script.scores = { coordinator: 0.9, infra: 0.9, doctor: 0.9 };
			fx.runtime.reply = (r) =>
				r.agent?.name === "doctor" ? "@Infra over to you" : "done";
			await round("@Doctor look at this");
			expect(speakers()).toEqual(["doctor", "infra"]);
		});

		test("a held approval still forces its seat beside the named member", async () => {
			script.scores = { coordinator: 0.9, infra: 0.1, doctor: 0.9 };
			fx.runtime.held.set(groupSessionKey(opsGroup(), "infra"), {
				selectionId: "agent",
				heldAt: new Date(),
				calls: [{ tool: "bash", input: "{}", action: "restart" }],
			});
			await round("@Coordinator yes, restart it");
			expect(speakers()).toEqual(["coordinator", "infra"]);
			expect(
				fx.runtime.turns.find((t) => t.agent?.name === "infra")?.confirmed,
			).toBe(true);
		});
	});
});
