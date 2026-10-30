import { describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	agentChannel,
	ENTRY,
	fx,
	restart,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { discordKey } from "./team-keys.ts";

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

/** The coordinator's owner turn, which runs `during` as the model's tool call would. */
async function coordinatorTurn(during: () => void): Promise<void> {
	fx.runtime.during = (request) => {
		if (request.agent?.name !== "coordinator") return;
		fx.runtime.during = undefined;
		during();
	};
	await fx.team.answerOwner(
		discordKey(ENTRY),
		OWNER_SPEAKER,
		"go",
		"go",
		NO_ATTACHMENTS,
	);
	await settle();
}

const coordinator = () => ({
	name: "coordinator",
	session: discordKey(ENTRY),
	home: discordKey(ENTRY),
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("agent messages that survive a stop", () => {
	useTeamFixture();

	test("a follow-up the stopping host refused is kept, and the sender hears the answer after the restart", async () => {
		fx.runtime.reply = (r) =>
			r.agent?.name === "infra" ? "disk 40%" : "asked infra";
		fx.runtime.during = (request) => {
			if (request.agent?.name === "coordinator")
				fx.team.message(coordinator(), "infra", "check the disk");
			// The shutdown begins while the target works: its turn finishes, the follow-up is refused.
			if (request.agent?.name === "infra") fx.queue.close();
		};
		await fx.team.answerOwner(
			discordKey(ENTRY),
			OWNER_SPEAKER,
			"go",
			"go",
			NO_ATTACHMENTS,
		);
		await keptCount(1);
		expect(fx.team.busy()).toEqual([]);
		const [kept] = await fx.store.outbox.pending();
		expect(kept).toMatchObject({
			kind: "reply",
			sender: "coordinator",
			target: "infra",
			channel: discordKey(ENTRY),
		});
		expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual([
			"coordinator",
			"infra",
		]);

		await restart();

		expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual(["coordinator"]);
		expect(fx.runtime.turns[0]?.text).toContain("disk 40%");
		expect(fx.runtime.turns[0]?.channel).toBe(discordKey(ENTRY));
		expect(await fx.store.outbox.pending()).toEqual([]);
	});

	test("a message sent while the host stops is kept and reaches the same conversation after the restart", async () => {
		await coordinatorTurn(() => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
		});
		await keptCount(1);
		expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual(["coordinator"]);
		const [kept] = await fx.store.outbox.pending();
		expect(kept).toMatchObject({
			kind: "message",
			target: "infra",
			channel: agentChannel("infra"),
		});

		fx.runtime.reply = (r) =>
			r.agent?.name === "infra" ? "disk 40%" : "noted";
		await restart();
		// restart() replaced the runtime; the replayed turns ran on the new one before it settled.
		expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual([
			"infra",
			"coordinator",
		]);
		expect(fx.runtime.turns[0]).toMatchObject({
			channel: agentChannel("infra"),
		});
		expect(fx.runtime.turns[0]?.text).toContain("check the disk");
		expect(fx.runtime.turns[1]?.text).toContain("infra");
		expect(await fx.store.outbox.pending()).toEqual([]);
	});

	test("delivered entries are not replayed again, even by two starts at once", async () => {
		await coordinatorTurn(() => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
		});
		await keptCount(1);
		await restart();
		const delivered = fx.runtime.turns.length;
		expect(delivered).toBe(2);

		await Promise.all([fx.team.start(), fx.team.start()]);
		await settle();
		await restart();
		expect(fx.runtime.turns).toHaveLength(0);
	});

	test("an entry is claimed once, so a second reader finds it gone", async () => {
		await coordinatorTurn(() => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
		});
		await keptCount(1);
		const outbox = fx.store.outbox;
		const [entry] = await outbox.pending();
		expect(await outbox.claim(entry?.id ?? 0)).toBe(true);
		expect(await outbox.claim(entry?.id ?? 0)).toBe(false);
		await restart();
		expect(fx.runtime.turns).toHaveLength(0);
	});

	test("kept messages replay in the order they were refused", async () => {
		await coordinatorTurn(() => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "first");
			fx.team.message(coordinator(), "infra", "second");
			fx.team.message(coordinator(), "infra", "third");
		});
		await keptCount(3);
		const texts = (await fx.store.outbox.pending()).map((e) => e.text);
		expect(texts).toEqual(["first", "second", "third"]);

		await restart();
		const infraTexts = fx.runtime.turns
			.filter((t) => t.agent?.name === "infra")
			.map((t) => t.text);
		expect(infraTexts).toHaveLength(3);
		expect(infraTexts[0]).toContain("first");
		expect(infraTexts[1]).toContain("second");
		expect(infraTexts[2]).toContain("third");
	});

	test("an entry whose agent was archived meanwhile is dropped, not run", async () => {
		await coordinatorTurn(() => {
			fx.queue.close();
			fx.team.message(coordinator(), "infra", "check the disk");
		});
		await keptCount(1);
		await fx.store.archiveAgent("infra");
		await restart();
		expect(fx.runtime.turns).toHaveLength(0);
		expect(await fx.store.outbox.pending()).toEqual([]);
	});
});
