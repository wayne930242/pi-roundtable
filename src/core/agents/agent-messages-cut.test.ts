import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import { discordKey } from "../contract/discord-key.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { TurnRequest } from "../domain/ports.ts";
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
	others?: (request: TurnRequest) => void,
): Promise<TurnRecord> {
	const turns = new RunningTurns();
	let record: TurnRecord | undefined;
	fx.runtime.during = async (request) => {
		if (request.agent?.name !== "coordinator" || record) {
			others?.(request);
			return;
		}
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

	/** The coordinator's turn messages infra while the host stops, so the message is kept; it then is stopped, or answers. */
	const sendWhileStopping = (answers = false) =>
		underPerson(async () => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
			fx.runtime.stopNext = !answers;
		});

	test("a message its turn sent is kept until the shutdown leaves the person's message, then taken out, since the next process asks it again", async () => {
		const record = await sendWhileStopping();
		await keptCount(1);
		await record.leave();
		expect(await fx.store.outbox.pending()).toEqual([]);
		expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual(["coordinator"]);
	});

	test("a message its turn sent stays kept when its turn answers, so the person's message is not left", async () => {
		const record = await sendWhileStopping(true);
		expect(record.unanswered()).toEqual([]);
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
	test("a message its turn sent before it answered stays kept when a message steered in later is left", async () => {
		const record = await underPerson(async () => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
		});
		await keptCount(1);
		// The coordinator answered; a message steered in afterwards is cut and left.
		expect(record.unanswered()).toEqual([]);
		record.add({ ...person, messageId: "m2" });
		await record.leave();
		await keptCount(1);
	});

	test("what a later hop of the chain keeps is taken out too when the person's message is left", async () => {
		const record = await underPerson(
			async () => {
				fx.team.message(coordinator(), "infra", "check the disk");
				fx.runtime.stopNext = true;
			},
			(request) => {
				// The target passes it on while the host stops: kept, as is the target's answer.
				if (request.agent?.name !== "infra") return;
				fx.queue.close();
				fx.team.message(request.agent, "doctor", "and the patient");
			},
		);
		await keptCount(2);
		await record.leave();
		expect(await fx.store.outbox.pending()).toEqual([]);
	});
	test("each send counts the answers its record had then: only one sent after the last answer is dropped when a later message is left", async () => {
		const record = await underPerson(async (record) => {
			fx.queue.close();
			fx.team.message(coordinator(), "doctor", "first");
			// Another turn of the admission answered; a message steered in after it waits.
			record.settle({ ok: true, text: "answered" });
			record.add({ ...person, messageId: "m2" });
			fx.team.message(coordinator(), "infra", "second");
			fx.runtime.stopNext = true;
		});
		await keptCount(2);
		await record.leave();
		expect(await fx.store.outbox.pending()).toEqual([
			expect.objectContaining({ target: "doctor", text: "first" }),
		]);
	});

	test("an answer kept after the message was left stays when its send came before an answer of the record", async () => {
		await underPerson(
			async (record) => {
				fx.team.message(coordinator(), "infra", "check the disk");
				record.settle({ ok: true, text: "answered" });
				record.add({ ...person, messageId: "m2" });
				await record.leave();
			},
			(request) => {
				// The follow-up to the coordinator is refused: the host stops while infra works.
				if (request.agent?.name === "infra") fx.queue.close();
			},
		);
		await keptCount(1);
		expect((await fx.store.outbox.pending())[0]).toMatchObject({
			kind: "reply",
		});
	});
	test("a later hop takes the answers of the send it follows: one after an answer of the record is dropped when a later message is left", async () => {
		const record = await underPerson(
			async (record) => {
				record.settle({ ok: true, text: "answered" });
				record.add({ ...person, messageId: "m2" });
				fx.team.message(coordinator(), "infra", "check the disk");
				fx.runtime.stopNext = true;
			},
			(request) => {
				if (request.agent?.name !== "infra") return;
				fx.queue.close();
				fx.team.message(request.agent, "doctor", "and the patient");
			},
		);
		await keptCount(2);
		await record.leave();
		expect(await fx.store.outbox.pending()).toEqual([]);
	});
});
