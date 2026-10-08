import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	ChannelClaim,
	InboundMessage,
} from "../core/contract/channels.ts";
import { runMigrations } from "../core/db/migrations.ts";
import { CARD_PREFIX, OwnerCards } from "../core/discord/owner-cards.ts";
import {
	fakeChannel,
	OWNER,
	press,
	tick,
} from "../core/discord/owner-cards-fixture.ts";
import { messages } from "../core/i18n/index.ts";
import type { AccessRules } from "../core/identity/access-policy.ts";
import { identityMigrations } from "../core/identity/identity-schema.ts";
import { PgIdentityService } from "../core/identity/identity-service.ts";
import { contactsOf, identityView } from "../core/identity/identity-view.ts";
import { PgPrincipalStore } from "../core/identity/principal-store.ts";
import { promptScope } from "../core/interactions/prompts.ts";
import { silentLogger } from "../core/log.ts";
import { ChannelQueue } from "../core/routing/channel-queue.ts";
import { ChannelRouter } from "../core/routing/channel-router.ts";
import type { Speaker } from "../core/speakers.ts";
import { describeDb } from "../core/testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../core/testing/fixture-database.ts";
import { mapIdentity } from "../core/testing/map-identity.ts";

// §6.2 of the M2 plan, the rows the other tests leave to Discord's parts on their own: A and B,
// two members of one tier, in a shared Discord conversation; and A disabled between two messages.
// src/m2-acceptance/acceptance-index.test.ts lists where the rest of §6.2 is tested.

const A = "100000000000000003";
const B = "100000000000000004";

const member = (id: string): Speaker => ({
	id,
	name: `name-${id}`,
	tier: "member",
	principalId: id,
});

describe("two members of one tier on Discord", () => {
	test("B's press on the card of A's held call in a shared conversation is refused; A's approves it", async () => {
		const fake = fakeChannel(true);
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity: mapIdentity({
				owners: [OWNER],
				members: { users: [A, B] },
			}),
			channel: fake.channel,
			logger: silentLogger(),
		});
		const answer = cards
			.prompts("discord:555", promptScope(member(A)))
			?.confirm("t", "**rm**", undefined, "member");
		await tick();
		const pressAs = async (user: string) => {
			const pressed = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
				user,
			});
			await cards.handle(pressed.interaction);
			return pressed.replies;
		};
		expect(await pressAs(B)).toEqual([messages().cardApproversRefusal]);
		expect(await pressAs(A)).toEqual([]);
		expect(await answer).toBe("approved");
	});
});

/** A Discord message as the Discord surface reports it. */
const discord = (author: string, text: string): InboundMessage => ({
	channel: "discord:10",
	messageId: `m-${author}-${text}-${crypto.randomUUID()}`,
	actor: {
		provider: "discord",
		subject: author,
		name: `name-${author}`,
		surface: "discord",
		roles: [],
		space: "1",
		legacyId: author,
	},
	authorId: author,
	authorName: `name-${author}`,
	authorIsBot: false,
	authorRoleIds: [],
	isDirect: false,
	space: "1",
	mentionsBot: false,
	repliesToBot: false,
	text,
	attachments: [],
});

const RULES: AccessRules = {
	owners: [{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] }],
	members: { everyone: ["discord"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

let db: ScratchDatabase;

describeDb("a Discord person disabled between two messages", () => {
	beforeAll(async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, [
			{ name: "identity", migrations: identityMigrations({ owners: [] }) },
		]);
	});
	afterAll(async () => {
		await db.drop();
	});

	test("is served, then their next message reaches no turn, and once enabled they are served again; B is served throughout", async () => {
		const service = new PgIdentityService(
			await PgPrincipalStore.attach(db.sql),
			RULES,
			{ logger: silentLogger() },
		);
		await service.syncConfig();
		const turns: Speaker[] = [];
		const claim: ChannelClaim = {
			name: "people",
			priority: 0,
			owns: (channel) => channel === "discord:10",
			admit: (message) =>
				message.speaker
					? {
							kind: "turn",
							run: async () => {
								if (message.speaker) turns.push(message.speaker);
							},
							failure: "failed",
						}
					: undefined,
			startFresh: async () => "people",
		};
		const router = new ChannelRouter({
			claims: [claim],
			targets: () => undefined,
			queue: new ChannelQueue(),
			logger: silentLogger(),
			contacts: contactsOf(identityView(service)),
		});
		const said = async (author: string) => {
			const before = turns.length;
			await router.handle(discord(author, "hello"));
			return turns.slice(before).map((speaker) => speaker.principalId);
		};
		const a = await said(A);
		expect(a).toHaveLength(1);
		const principal = a[0] ?? "";
		expect(await said(B)).toHaveLength(1);
		// As `roundtable principal disable` does; this process writes through the same store.
		await service.store.disable(principal);
		expect(await said(A)).toEqual([]);
		expect(await said(B)).toHaveLength(1);
		await service.store.enable(principal);
		expect(await said(A)).toEqual([principal]);
	});
});
