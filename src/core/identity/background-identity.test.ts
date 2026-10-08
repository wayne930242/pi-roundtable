import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ScheduledOutcome } from "../contract/channels.ts";
import { runMigrations } from "../db/migrations.ts";
import { silentLogger } from "../log.ts";
import { ConversationBackgroundTurns } from "../modules/background/background-turns.ts";
import type { Schedule } from "../modules/schedules/schedule-store.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { ChannelRouter } from "../routing/channel-router.ts";
import type { Speaker } from "../speakers.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import type { AccessRules } from "./access-policy.ts";
import { identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { identityView, legacyPrincipalsOf } from "./identity-view.ts";
import { PgPrincipalStore } from "./principal-store.ts";

const ADA = "966666600000000001";
const DAY_MS = 24 * 60 * 60 * 1000;

const RULES: AccessRules = {
	owners: [{ name: "Ada", principal: ADA, identities: [`discord:${ADA}`] }],
	members: { roles: ["web:role:App.User"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

const web = (sub: string, roles: string[] = ["web:role:App.User"]) => ({
	provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20",
	subject: sub,
	name: `Web ${sub}`,
	surface: "web",
	roles,
});

let db: ScratchDatabase;
let store: PgPrincipalStore;
let clock: number;

describeDb(
	"background turns as the identity service sees their principal",
	() => {
		beforeAll(async () => {
			db = await scratchDatabase();
			await runMigrations(db.sql, [
				{ name: "identity", migrations: identityMigrations({ owners: [] }) },
			]);
			store = await PgPrincipalStore.attach(db.sql);
		});
		beforeEach(async () => {
			clock = Date.parse("2026-10-08T12:00:00Z");
			await db.sql`TRUNCATE principal_roles, principal_identities, principals`;
		});
		afterAll(async () => {
			await db.drop();
		});

		/** The host's path for a due schedule: background turns over the router, as `IDENTITY` resolves. */
		async function host() {
			const service = new PgIdentityService(store, RULES, {
				logger: silentLogger(),
				now: () => clock,
			});
			await service.syncConfig();
			const identity = identityView(service);
			const ran: Speaker[] = [];
			const router = new ChannelRouter({
				claims: [
					{
						name: "chat",
						priority: 0,
						owns: () => true,
						admit: () => undefined,
						background: async (turn) => {
							if (turn.speaker) ran.push(turn.speaker);
							return { status: "ran" };
						},
						startFresh: async () => "chat",
					},
				],
				targets: (name) => ({ name, label: () => name }),
				queue: new ChannelQueue(),
				logger: silentLogger(),
				principals: identity,
			});
			const turns = new ConversationBackgroundTurns({
				conversations: router,
				system: { id: "assistant", name: "Zed" },
				principalOf: legacyPrincipalsOf(identity),
				logger: silentLogger(),
			});
			// SAFETY: runScheduled reads only these fields of a schedule.
			const fire = (createdById: string): Promise<ScheduledOutcome> =>
				turns.runScheduled(
					{
						id: 1,
						channel: "web:c1",
						target: "chat",
						title: "patrol",
						prompt: "check the disk",
						recurrence: { kind: "once", date: "2026-10-08", time: "09:00" },
						createdById,
						createdByName: "Someone",
						createdTier: "member",
					} as unknown as Schedule,
					new Date(clock),
				);
			return { service, ran, fire };
		}

		test("a disabled principal's schedule is skipped, saying so, and runs again once they are enabled", async () => {
			const { service, ran, fire } = await host();
			const kai = (await service.resolve(web("kai")))?.principalId ?? "";
			expect(await fire(kai)).toEqual({ status: "ran" });
			// As `roundtable principal disable` does, seen by the host once its cache turns over.
			await service.store.disable(kai);
			const skipped = await fire(kai);
			expect(skipped.status).toBe("skipped");
			expect(skipped.status === "skipped" && skipped.reason).toContain(
				"disabled",
			);
			await service.store.enable(kai);
			expect(await fire(kai)).toEqual({ status: "ran" });
			expect(ran.map((speaker) => speaker.principalId)).toEqual([kai, kai]);
		});

		test("the schedule of someone whose tier comes only from the identity provider is skipped once backgroundStaleDays pass unseen", async () => {
			const { service, ran, fire } = await host();
			const noa = (await service.resolve(web("noa")))?.principalId ?? "";
			clock += 29 * DAY_MS;
			expect(await fire(noa)).toEqual({ status: "ran" });
			clock += 2 * DAY_MS;
			const skipped = await fire(noa);
			expect(skipped.status).toBe("skipped");
			expect(skipped.status === "skipped" && skipped.reason).toContain(
				"access.backgroundStaleDays",
			);
			expect(ran).toEqual([
				{ id: noa, name: "Someone", tier: "member", principalId: noa },
			]);
		});

		test("a configured owner's schedule runs at the tier it was set at, below theirs", async () => {
			const { ran, fire } = await host();
			expect(await fire(ADA)).toEqual({ status: "ran" });
			expect(ran).toEqual([
				{ id: ADA, name: "Someone", tier: "member", principalId: ADA },
			]);
		});
	},
);
