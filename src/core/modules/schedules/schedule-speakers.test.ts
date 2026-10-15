import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentClaim } from "../../agents/agent-claim.ts";
import { silentLogger } from "../../log.ts";
import { ChannelQueue } from "../../routing/channel-queue.ts";
import { ChannelRouter } from "../../routing/channel-router.ts";
import { type Speaker, type Tier, tierAtLeast } from "../../speakers.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER } from "../../testing/owner.ts";
import { fakePrecheck, fakePrechecks } from "../../testing/prechecks.ts";
import { ConversationBackgroundTurns } from "../background/background-turns.ts";
import { PERSONAL_TARGET } from "../background/personal-target.ts";
import type { Schedule } from "./schedule-store.ts";
import { Scheduler } from "./scheduler.ts";

const now = new Date("2026-10-01T10:00:00Z");

beforeAll(() => useTestLocale({ timeZone: "Asia/Taipei" }));
afterAll(useTestLocale);

function schedule(id: number, createdById: string): Schedule {
	return {
		id,
		channel: "discord:10",
		target: PERSONAL_TARGET.name,
		title: `daily ${id}`,
		prompt: "report",
		recurrence: {
			kind: "every",
			time: "18:00",
			everyDays: 1,
			startDate: "2026-10-01",
		},
		nextRun: now,
		precheck: "health.wake",
		createdById,
		createdByName: createdById,
		createdTier: createdById === "p_ada" ? "owner" : "admin",
		createdAt: now,
	};
}

/** The agent server's claim under `speakers`, behind a router that knows Ada an owner and Kai an admin. */
function harness(speakers: "everyone" | "owners") {
	const answered: Speaker[] = [];
	const claim = agentClaim({
		owner: TEST_OWNER,
		speakers,
		team: {
			guildId: "1",
			owns: () => "agent" as const,
			answerBackground: async (_c: string, speaker: Speaker) => {
				answered.push(speaker);
				return { ok: true as const, text: "" };
			},
			startFresh: async () => {},
			// biome-ignore lint/suspicious/noExplicitAny: a recording stand-in for the team
		} as any,
		runtime: { steer: async () => false, stop: () => false },
		surface: { react: async () => {}, unreact: async () => {} },
		attachmentDir: () => "/tmp",
		logger: silentLogger(),
	});
	const tiers: Record<string, Tier> = { p_ada: "owner", p_kai: "admin" };
	const router = new ChannelRouter({
		claims: [claim],
		targets: (name) =>
			name === PERSONAL_TARGET.name ? PERSONAL_TARGET : undefined,
		queue: new ChannelQueue(),
		logger: silentLogger(),
		principals: {
			speakerFor: async (
				principalId: string,
				tier?: Tier,
			): Promise<Speaker> => {
				const own = tiers[principalId];
				return {
					id: principalId,
					name: principalId,
					tier:
						own && tier && tierAtLeast(own, tier) ? tier : (own ?? "member"),
					principalId,
				};
			},
		},
	});
	const precheck = fakePrecheck("health.wake", {
		wake: true,
		context: "ready",
	});
	const statuses: { id: number; status: string }[] = [];
	const due: Schedule[] = [];
	const scheduler = new Scheduler({
		store: {
			due: async () => due,
			claim: async () => true,
			recordStatus: async (id, status) => {
				statuses.push({ id, status });
			},
		},
		prechecks: fakePrechecks(precheck),
		runner: new ConversationBackgroundTurns({
			conversations: router,
			system: { id: "system", name: "System" },
			logger: silentLogger(),
		}),
		logger: silentLogger(),
		now: () => now,
	});
	return { scheduler, precheck, statuses, due, answered };
}

describe("a schedule under agentSpeakers", () => {
	test("owners only: a non-owner's schedule starts no precheck and no turn, and is skipped for the speakers rule; the owner's runs as before", async () => {
		const h = harness("owners");
		h.due.push(schedule(1, "p_kai"), schedule(2, "p_ada"));
		await h.scheduler.tick();
		await h.scheduler.idle();
		expect(h.precheck.calls.map((c) => c.schedule.id)).toEqual([2]);
		expect(h.answered.map((s) => s.principalId)).toEqual(["p_ada"]);
		expect(h.statuses).toEqual([
			{
				id: 1,
				status:
					'skipped: the agent server answers owners only (speakers: "owners")',
			},
			{ id: 2, status: "woken by precheck; ran" },
		]);
	});

	test("everyone: a non-owner's schedule runs its precheck and its turn", async () => {
		const h = harness("everyone");
		h.due.push(schedule(1, "p_kai"));
		await h.scheduler.tick();
		await h.scheduler.idle();
		expect(h.precheck.calls).toHaveLength(1);
		expect(h.answered.map((s) => s.principalId)).toEqual(["p_kai"]);
		expect(h.statuses).toEqual([{ id: 1, status: "woken by precheck; ran" }]);
	});
});
