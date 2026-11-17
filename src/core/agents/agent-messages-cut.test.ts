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
		expect(record.unanswered()).toEqual([person]);
	});

	/** Waits until the outbox holds `count` entries; the write to it is not part of the turn. */
	async function keptCount(count: number): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (
			(await fx.store.outbox.pending()).length !== count &&
			Date.now() < deadline
		)
			await Bun.sleep(5);
		expect(await fx.store.outbox.pending()).toHaveLength(count);
	}

	/** The coordinator's turn messages infra while the host stops, so the message is kept. */
	const sendWhileStopping = () =>
		underPerson(async () => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
			fx.runtime.stopNext = true;
		});

	test("a message its turn sent is kept until the shutdown leaves the person's message, then taken out, since the next process asks it again", async () => {
		const record = await sendWhileStopping();
		await keptCount(1);
		await record.leave();
		expect(await fx.store.outbox.pending()).toEqual([]);
		expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual(["coordinator"]);
	});

	test("a message its turn sent stays kept when the person's message is not left, as when the turn answered in the grace", async () => {
		await sendWhileStopping();
		await keptCount(1);
	});

	test("a message sent after the person's message was left is not kept at all", async () => {
		await underPerson(async (record) => {
			await record.leave();
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
		});
		expect(fx.team.busy()).toEqual([]);
		expect(await fx.store.outbox.pending()).toEqual([]);
	});
});
