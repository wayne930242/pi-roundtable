import { expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { describeDb, openTestStore, TEST_GUILD } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { PgAgentStore } from "./agent-store.ts";
import { fx, settle, useTeamFixture } from "./agent-team-fixture.ts";
import { inTurn, SCOUT, turnsOf } from "./helper-test-kit.ts";
import { agentRoomKey, discordKey } from "./team-keys.ts";

const ROOM = agentRoomKey("app", "coordinator");
const inRoom: AgentTurnScope = {
	name: "coordinator",
	session: ROOM,
	home: ROOM,
};

/** Runs `action` during the coordinator's turn in its web room, as a tool the model calls. */
async function inRoomTurn<T>(
	action: (caller: AgentTurnScope) => Promise<T>,
): Promise<T> {
	await settle();
	let outcome: { value: T } | { error: unknown } | undefined;
	fx.runtime.during = async (request) => {
		if (request.agent?.name !== "coordinator") return;
		fx.runtime.during = undefined;
		outcome = await action(inRoom).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
	};
	await fx.queue.run(ROOM, () =>
		fx.team.answerOwner(ROOM, OWNER_SPEAKER, "go", "go", NO_ATTACHMENTS),
	);
	fx.runtime.during = undefined;
	await settle();
	if (!outcome) throw new Error("no coordinator turn ran the action");
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}

/** Makes a temp knight from the coordinator's web room. */
async function webBorn(): Promise<void> {
	await inRoomTurn((caller) => fx.team.helperCreate(caller, SCOUT));
}

const threadCount = () => fx.channels.threads.size;

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("temp knights live on the surface that made them", () => {
	useTeamFixture();

	test("one made in the web app gets no thread, and its task runs in its room", async () => {
		fx.surfaces.rooms = ["app"];
		await webBorn();
		const helper = fx.store.agent("coordinator-1");
		expect(helper?.parent).toBe("coordinator");
		expect(helper?.origin).toBe(ROOM);
		expect(helper?.channelId).toBeUndefined();
		expect(threadCount()).toBe(0);
		expect(turnsOf("coordinator-1")[0]?.channel).toBe(
			agentRoomKey("app", "coordinator-1"),
		);
	});

	test("a message from Discord that names discord makes its thread, once", async () => {
		fx.surfaces.rooms = ["app"];
		await webBorn();
		await inTurn("coordinator", async (caller) => {
			await Promise.all([
				fx.team.reach?.(caller, "coordinator-1", "discord"),
				fx.team.reach?.(caller, "coordinator-1", "discord"),
			]);
			fx.team.message(caller, "coordinator-1", "Now here.", "discord");
			await fx.team.reach?.(caller, "coordinator-1", "discord");
		});
		await settle();
		expect(threadCount()).toBe(1);
		const channelId = fx.store.agent("coordinator-1")?.channelId ?? "";
		expect(fx.channels.threads.get(channelId)?.parent).toBe("1000");
		const ran = turnsOf("coordinator-1").find((turn) =>
			turn.text.includes("Now here."),
		);
		expect(ran?.channel).toBe(discordKey(channelId));
	});

	test("a message that does not name discord makes no thread", async () => {
		fx.surfaces.rooms = ["app"];
		await webBorn();
		await inTurn("coordinator", async (caller) => {
			await fx.team.reach?.(caller, "coordinator-1", undefined);
			await fx.team.reach?.(caller, "coordinator-1", "web");
		});
		expect(threadCount()).toBe(0);
	});

	test("a turn that may not message it makes no thread", async () => {
		fx.surfaces.rooms = ["app"];
		await webBorn();
		const guest = { ...OWNER_SPEAKER, tier: "member" as const };
		await inTurn(
			"coordinator",
			(caller) =>
				fx.team.reach?.(caller, "coordinator-1", "discord") ??
				Promise.resolve(),
			guest,
		);
		expect(threadCount()).toBe(0);
	});

	test("one made on Discord still gets its thread at once", async () => {
		fx.surfaces.rooms = ["app"];
		await inTurn("coordinator", (caller) =>
			fx.team.helperCreate(caller, SCOUT),
		);
		expect(fx.store.agent("coordinator-1")?.channelId).toBeDefined();
		expect(threadCount()).toBe(1);
	});

	test("archiving and restoring one without a thread makes none and does not fail", async () => {
		fx.surfaces.rooms = ["app"];
		await webBorn();
		const said = await inRoomTurn((caller) =>
			fx.team.helperEnd(caller, ["coordinator-1"]),
		);
		expect(said).toContain("Archived 1 temp knight");
		expect(fx.store.agent("coordinator-1")?.status).toBe("archived");
		expect(await fx.team.restoreHelpers(["coordinator-1"])).toEqual([
			"coordinator-1",
		]);
		expect(fx.store.agent("coordinator-1")?.channelId).toBeUndefined();
		expect(threadCount()).toBe(0);
	});

	test("restore reopens the thread it was given, and never makes a new one", async () => {
		fx.surfaces.rooms = ["app"];
		await webBorn();
		await inTurn(
			"coordinator",
			async (caller) =>
				await fx.team.reach?.(caller, "coordinator-1", "discord"),
		);
		const thread = fx.store.agent("coordinator-1")?.channelId ?? "";
		await fx.team.archiveHelpers(["coordinator-1"], "owner");
		expect(fx.channels.threads.get(thread)?.archived).toBe(true);
		await fx.team.restoreHelpers(["coordinator-1"]);
		expect(fx.channels.threads.get(thread)?.archived).toBe(false);
		// Its thread deleted meanwhile: restored without a new one.
		await fx.team.archiveHelpers(["coordinator-1"], "owner");
		fx.channels.deleted.add(thread);
		await fx.team.restoreHelpers(["coordinator-1"]);
		expect(fx.store.agent("coordinator-1")?.status).toBe("active");
		expect(threadCount()).toBe(1);
	});

	test("its origin survives a restart", async () => {
		fx.surfaces.rooms = ["app"];
		await webBorn();
		const reopened = await openTestStore(PgAgentStore, TEST_GUILD);
		try {
			expect(reopened.agent("coordinator-1")?.origin).toBe(ROOM);
		} finally {
			await reopened.close();
		}
	});
});
