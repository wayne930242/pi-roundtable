import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import { discordKey } from "../contract/discord-key.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { RunningTurns, type TurnRecord } from "../routing/turn-records.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { ENTRY, fx, settle, useTeamFixture } from "./agent-team-fixture.ts";

const person: InboundMessage = {
	channel: discordKey(ENTRY),
	messageId: "m1",
	authorId: "owner",
	authorName: "Riley",
	authorIsBot: false,
	isDirect: false,
	mentionsBot: true,
	repliesToBot: false,
	text: "go",
	attachments: [],
};

const coordinator = () => ({
	name: "coordinator",
	session: discordKey(ENTRY),
	home: discordKey(ENTRY),
});

/** The coordinator's turn for the person's message, run as routing runs it; `during` acts as its tool call. */
async function underPerson(
	during: (record: TurnRecord, turns: RunningTurns) => Promise<void>,
): Promise<TurnRecord> {
	const turns = new RunningTurns();
	let record: TurnRecord | undefined;
	fx.runtime.during = async (request) => {
		if (request.agent?.name !== "coordinator") return;
		fx.runtime.during = undefined;
		record = turns.running(person.channel);
		if (record) await during(record, turns);
	};
	await turns.run(person, () =>
		fx.team.answerOwner(
			person.channel,
			OWNER_SPEAKER,
			"go",
			"go",
			NO_ATTACHMENTS,
		),
	);
	await settle();
	if (!record) throw new Error("the coordinator's turn did not run");
	return record;
}

const answeredCard = () =>
	fx.channels.posts.some((p) => p.post.intercom?.kind === "answered");

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set or a local one starts.
describeDb("agent messages from a turn the shutdown cuts", () => {
	useTeamFixture();

	test("the other agent's answer is not taken for the answer to the person's message", async () => {
		const record = await underPerson(async () => {
			fx.team.message(coordinator(), "infra", "check the disk");
			const deadline = Date.now() + 5_000;
			while (!answeredCard() && Date.now() < deadline) await Bun.sleep(5);
			// The sender's own turn is stopped after the target answered.
			fx.runtime.stopNext = true;
		});
		expect(answeredCard()).toBe(true);
		record.markCut();
		expect(record.leave()).toBe(true);
	});

	test("a message the cut turn sent is dropped, not kept for the next start, since its person's message is asked again", async () => {
		await underPerson(async (_record, turns) => {
			fx.queue.close();
			turns.cut();
			fx.team.message(coordinator(), "infra", "check the disk");
			fx.runtime.stopNext = true;
		});
		expect(fx.team.busy()).toEqual([]);
		expect(await fx.store.outbox.pending()).toEqual([]);
		expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual(["coordinator"]);
	});
});
