import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import { runMigrations } from "../db/migrations.ts";
import { silentLogger } from "../log.ts";
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
import { contactsOf, identityView } from "./identity-view.ts";
import { PgPrincipalStore } from "./principal-store.ts";

const ADA = "966666600000000001";
const KAI = "966666600000000003";
const NEW = "966666600000000004";

const RULES: AccessRules = {
	owners: [{ name: "Ada", principal: ADA, identities: [`discord:${ADA}`] }],
	members: { everyone: ["discord"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

/** A Discord message as the Discord surface reports it. */
const discord = (
	author: string,
	text: string,
	channel: `discord:${string}` = "discord:10",
): InboundMessage => ({
	channel,
	messageId: `m-${author}-${text}`,
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

let db: ScratchDatabase;
let store: PgPrincipalStore;

describeDb("the router resolving authors through the identity service", () => {
	beforeAll(async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, [
			{ name: "identity", migrations: identityMigrations({ owners: [] }) },
		]);
		store = await PgPrincipalStore.attach(db.sql);
	});
	beforeEach(async () => {
		await db.sql`TRUNCATE principal_roles, principal_identities, principals`;
	});
	afterAll(async () => {
		await db.drop();
	});

	/** A router over a claim that takes only messages saying "take", recording whom it saw. */
	async function setup() {
		const service = new PgIdentityService(store, RULES, {
			logger: silentLogger(),
		});
		await service.syncConfig();
		const seen: Speaker[] = [];
		const claim: ChannelClaim = {
			name: "people",
			priority: 0,
			owns: (channel) => channel === "discord:10",
			admit: (message) =>
				message.speaker && message.text === "take"
					? {
							kind: "turn",
							run: async () => {
								if (message.speaker) seen.push(message.speaker);
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
			// As the host gives it: through the view plugins get.
			contacts: contactsOf(identityView(service)),
		});
		return { router, seen };
	}

	test("a Discord user carried over from 0.8 is their old principal, before and after the claim", async () => {
		await db.sql`INSERT INTO principals (id, display_name, claimable) VALUES (${KAI}, 'Kai', true)`;
		const { router, seen } = await setup();
		await router.handle(discord(KAI, "take"));
		await router.handle(discord(KAI, "take"));
		await router.handle(discord(ADA, "take"));
		expect(seen).toEqual([
			{ id: KAI, name: `name-${KAI}`, tier: "member", principalId: KAI },
			{ id: KAI, name: `name-${KAI}`, tier: "member", principalId: KAI },
			{ id: ADA, name: `name-${ADA}`, tier: "owner", principalId: ADA },
		]);
		expect(await store.identity("discord", KAI)).toMatchObject({
			principalId: KAI,
			source: "legacy",
		});
	});

	test("messages no claim takes, in a channel a claim owns or not, write nothing: no principal, no claim, no seen", async () => {
		await db.sql`INSERT INTO principals (id, display_name, claimable) VALUES (${KAI}, 'Kai', true)`;
		const { router, seen } = await setup();
		const before = {
			principals: await db.sql`SELECT * FROM principals ORDER BY id`,
			links: await db.sql`SELECT * FROM principal_identities`,
		};
		for (const author of [KAI, NEW, ADA]) {
			await router.handle(discord(author, "chatter"));
			await router.handle(discord(author, "take", "discord:99"));
		}
		expect(seen).toEqual([]);
		expect(await db.sql`SELECT * FROM principals ORDER BY id`).toEqual(
			before.principals,
		);
		expect(await db.sql`SELECT * FROM principal_identities`).toEqual(
			before.links,
		);
		// Once a claim takes one, that person alone is admitted, as the principal they were assessed as.
		await router.handle(discord(NEW, "take"));
		const link = await store.identity("discord", NEW);
		expect(link).toMatchObject({ source: "jit" });
		expect(seen.map((speaker) => speaker.principalId)).toEqual([
			link?.principalId ?? "",
		]);
		expect(
			(await db.sql`SELECT id FROM principals WHERE id LIKE 'p_%'`).length,
		).toBe(1);
	});

	test("a replacement IDENTITY that only resolves is asked once per message, as the router's assessor", async () => {
		const asked: string[] = [];
		const assessor = contactsOf({
			...identityView(
				new PgIdentityService(store, RULES, { logger: silentLogger() }),
			),
			resolve: async (facts) => {
				asked.push(facts.subject);
				return {
					id: facts.subject,
					name: facts.name,
					tier: "member",
					principalId: "p_x",
				};
			},
		});
		const contact = await assessor.assess({
			provider: "discord",
			subject: KAI,
			name: "Kai",
		});
		expect(await contact?.take()).toEqual(contact?.speaker);
		expect(asked).toEqual([KAI]);
	});
});
