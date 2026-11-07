import { expect, test } from "bun:test";
import { DISPLAY_KINDS } from "pi-better-show";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { describeDb } from "../testing/database.ts";
import { ALL_BLOCKS_REPLY, fencesIn } from "../testing/fixtures/all-blocks.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	agentChannel,
	duringTurn,
	fx,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { agentRoomKey } from "./team-keys.ts";

const longTable = [
	"```table",
	"columns: [name, size]",
	"rows:",
	...Array.from({ length: 200 }, (_, i) => `  - [row ${i} of the table, ${i}]`),
	"```",
].join("\n");

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb(
	"an agent's reply with display blocks, in its Discord channel",
	() => {
		useTeamFixture();

		test("reaches the webhook as text, with no block fence but Discord's diff", async () => {
			fx.runtime.reply = () => ALL_BLOCKS_REPLY;
			await fx.team.answerOwner(
				agentChannel("infra"),
				OWNER_SPEAKER,
				"show",
				"show",
				NO_ATTACHMENTS,
			);
			const chunks = fx.channels.posts.flatMap((p) => p.post.chunks);
			expect(chunks.length).toBeGreaterThan(0);
			expect(fencesIn(chunks.join("\n"))).toEqual(["diff"]);
			for (const chunk of chunks)
				expect(chunk.length).toBeLessThanOrEqual(2000);
		});

		test("a message to another agent is posted as text too", async () => {
			const coordinator = agentChannel("coordinator");
			fx.runtime.reply = (request) =>
				request.agent?.name === "coordinator" ? "sent" : "got it";
			await duringTurn(async () =>
				fx.team.message(
					{ name: "coordinator", session: coordinator, home: coordinator },
					"infra",
					ALL_BLOCKS_REPLY,
				),
			);
			await settle();
			const chunks = fx.channels.posts.flatMap((p) => p.post.chunks);
			expect(chunks.join("\n")).toContain("Here is the plan.");
			expect(new Set(fencesIn(chunks.join("\n")))).toEqual(new Set(["diff"]));
		});
	},
);

describeDb("an agent's reply with display blocks, in an app room", () => {
	useTeamFixture({ local: true });
	const room = agentRoomKey("app", "infra");

	test("reaches a surface that draws the kinds whole, and a surface that draws none as text", async () => {
		const text = `Data.\n\n${longTable}`;
		fx.runtime.reply = () => text;
		fx.surfaces.of = () => ({ blocks: DISPLAY_KINDS }) as never;
		await fx.team.answerOwner(
			room,
			OWNER_SPEAKER,
			"show",
			"show",
			NO_ATTACHMENTS,
		);
		expect(fx.surfaces.replies.at(-1)?.reply.chunks).toEqual([text]);
		fx.surfaces.replies.length = 0;
		fx.surfaces.of = () => ({}) as never;
		await fx.team.answerOwner(
			room,
			OWNER_SPEAKER,
			"again",
			"again",
			NO_ATTACHMENTS,
		);
		const chunks = fx.surfaces.replies.at(-1)?.reply.chunks ?? [];
		expect(chunks.join("\n")).not.toContain("```table");
		expect(chunks.join("\n")).toContain("• name: row 0 of the table");
	});
});
