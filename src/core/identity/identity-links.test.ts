import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { ConfigError, IdentityError } from "../domain/errors.ts";
import type { Logger } from "../log.ts";
import { IDENTITY, IDENTITY_LINKS } from "../services.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import { type AccessRules, checkAccessRules } from "./access-policy.ts";
import type { ActorFacts } from "./actor-facts.ts";
import { CACHE_MS } from "./caching-principal-store.ts";
import { identityLinks } from "./identity-links.ts";
import { identityPlugin } from "./identity-plugin.ts";
import { identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { PgPrincipalStore, SYSTEM_PRINCIPAL } from "./principal-store.ts";

const ADA = "966666600000000001";
const KAI = "966666600000000003";
const BOB = "966666600000000004";
const PERSON = "966666600000000009";

const RULES: AccessRules = {
	owners: [
		{
			name: "Ada",
			pronouns: "she",
			principal: ADA,
			identities: [`discord:${ADA}`],
		},
	],
	members: { everyone: ["web"] },
	provisioning: "linked",
	backgroundStaleDays: 30,
	selfLink: { providers: ["discord"] },
};

const discordFacts = (id: string) =>
	({
		provider: "discord",
		subject: id,
		name: "Someone",
		roles: [],
		legacyId: id,
	}) satisfies ActorFacts;

/** A logger that keeps what it is given, to check what reaches the log. */
function recordingLogger(): { logger: Logger; lines: string[] } {
	const lines: string[] = [];
	const write = (fields: object | string, message?: string) =>
		lines.push(
			typeof fields === "string"
				? fields
				: `${JSON.stringify(fields)} ${message}`,
		);
	const logger: Logger = {
		debug: write,
		info: write,
		warn: write,
		error: write,
		fatal: write,
		child: () => logger,
	};
	return { logger, lines };
}

describeDb("IDENTITY_LINKS, the self-link service", () => {
	let db: ScratchDatabase;
	let store: PgPrincipalStore;
	let clock: number;
	let lines: string[];
	let host: PgIdentityService;
	let links: ReturnType<typeof identityLinks>;

	beforeAll(async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, [
			{ name: "identity", migrations: identityMigrations({ owners: [] }) },
		]);
		store = await PgPrincipalStore.attach(db.sql);
	});
	beforeEach(async () => {
		clock = Date.parse("2026-10-13T12:00:00Z");
		await db.sql`TRUNCATE principal_roles, principal_identities, principals`;
		const recording = recordingLogger();
		lines = recording.lines;
		host = new PgIdentityService(store, RULES, {
			logger: recording.logger,
			now: () => clock,
		});
		await host.syncConfig();
		links = identityLinks(
			host.store,
			RULES.selfLink as NonNullable<AccessRules["selfLink"]>,
			recording.logger,
		);
	});
	afterAll(async () => {
		await db.drop();
	});

	/** The rows the refused call must not have changed. */
	const rows = () =>
		db.sql`SELECT provider, subject, principal_id, source FROM principal_identities ORDER BY provider, subject`;

	test("links a listed provider's identity to a principal as a self link, served at once", async () => {
		const kai = await host.store.create({ displayName: "Kai" });
		expect(await host.resolve(discordFacts(KAI))).toBeUndefined();
		const link = await links.link(kai.id, `discord:${KAI}`);
		expect(link).toMatchObject({
			provider: "discord",
			subject: KAI,
			principalId: kai.id,
			source: "self",
		});
		expect(Object.isFrozen(link)).toBe(true);
		// The read before the link was cached as "no one": the link's own write drops it.
		expect(await host.principalOf(`discord:${KAI}`)).toBe(kai.id);
	});

	test("refuses an unlisted provider, a malformed identity, the system principal, an owner, and a principal that does not exist", async () => {
		const kai = await host.store.create({ displayName: "Kai" });
		const cliOwner = await host.store.create({ displayName: "Bo" });
		await host.store.grant(cliOwner.id, "owner", "cli");
		const refuse = async (
			principal: string,
			identity: string,
			text: RegExp,
		) => {
			const before = await rows();
			await expect(links.link(principal, identity)).rejects.toThrow(
				IdentityError,
			);
			await expect(links.link(principal, identity)).rejects.toThrow(text);
			expect(await rows()).toEqual(before);
		};
		await refuse(kai.id, `web:${KAI}`, /access\.selfLink lists discord/);
		await refuse(kai.id, `token:${KAI}`, /access\.selfLink lists discord/);
		await refuse(kai.id, `legacy:${KAI}`, /access\.selfLink lists discord/);
		await refuse(kai.id, "discord", /not an identity/);
		await refuse(kai.id, "discord:", /not an identity/);
		await refuse(SYSTEM_PRINCIPAL, `discord:${KAI}`, /no identities/);
		await refuse(ADA, `discord:${KAI}`, /is an owner/);
		await refuse(cliOwner.id, `discord:${KAI}`, /is an owner/);
		await refuse("p_missing", `discord:${KAI}`, /no principal/);
	});

	test("refuses an identity linked to another principal, whoever linked it", async () => {
		const kai = await host.store.create({ displayName: "Kai" });
		const bob = await host.store.create({ displayName: "Bob" });
		await host.store.link(bob.id, { provider: "discord", subject: BOB }, "cli");
		await host.store.link(
			bob.id,
			{ provider: "discord", subject: PERSON },
			"self",
		);
		const before = await rows();
		for (const subject of [ADA, BOB, PERSON])
			await expect(links.link(kai.id, `discord:${subject}`)).rejects.toThrow(
				/already linked to principal/,
			);
		expect(await rows()).toEqual(before);
	});

	test("linking again to the same principal changes nothing, and keeps the source another way gave", async () => {
		const kai = await host.store.create({ displayName: "Kai" });
		const first = await links.link(kai.id, `discord:${KAI}`);
		const again = await links.link(kai.id, `discord:${KAI}`);
		expect(again).toEqual(first);
		const bob = await host.store.create({ displayName: "Bob" });
		await host.store.link(bob.id, { provider: "discord", subject: BOB }, "cli");
		expect(await links.link(bob.id, `discord:${BOB}`)).toMatchObject({
			source: "cli",
		});
		expect(await rows()).toHaveLength(3);
		// A link the CLI made stays the CLI's: the person cannot unlink it.
		await expect(links.unlink(`discord:${BOB}`)).rejects.toThrow(/cli/);
	});

	test("unlinks only a self link", async () => {
		const kai = await host.store.create({ displayName: "Kai" });
		await links.link(kai.id, `discord:${KAI}`);
		expect(await links.unlink(`discord:${KAI}`)).toBe(true);
		expect(await host.principalOf(`discord:${KAI}`)).toBeUndefined();
		expect(await links.unlink(`discord:${KAI}`)).toBe(false);
		for (const source of [
			"config",
			"plugin",
			"cli",
			"jit",
			"legacy",
		] as const) {
			const subject = `96666660000000010${["config", "plugin", "cli", "jit", "legacy"].indexOf(source)}`;
			await host.store.link(kai.id, { provider: "discord", subject }, source);
			await expect(links.unlink(`discord:${subject}`)).rejects.toThrow(
				`linked by ${source}`,
			);
			expect(await host.principalOf(`discord:${subject}`)).toBe(kai.id);
		}
		// The owner's configured identity is the configuration's.
		await expect(links.unlink(`discord:${ADA}`)).rejects.toThrow(/config/);
		await expect(links.unlink("nonsense")).rejects.toThrow(/not an identity/);
	});

	test("a self link another source took over in the meantime is not removed", async () => {
		const kai = await host.store.create({ displayName: "Kai" });
		await links.link(kai.id, `discord:${KAI}`);
		await host.store.link(
			kai.id,
			{ provider: "discord", subject: KAI },
			"config",
		);
		expect(await host.store.unlink("discord", KAI, "self")).toBe(false);
		expect(await host.principalOf(`discord:${KAI}`)).toBe(kai.id);
	});

	test("a link serves the person under the rules at once, an unlink stops it, and both are read again after 30 seconds only from another process", async () => {
		const kai = await host.store.create({ displayName: "Kai" });
		await host.store.grant(kai.id, "member", "cli");
		await links.link(kai.id, `discord:${KAI}`);
		expect(await host.resolve(discordFacts(KAI))).toMatchObject({
			principalId: kai.id,
			tier: "member",
		});
		await links.unlink(`discord:${KAI}`);
		expect(await host.resolve(discordFacts(KAI))).toBeUndefined();

		// Another process's write: read from the cache until it expires.
		expect(await host.principalOf(`discord:${BOB}`)).toBeUndefined();
		await db.sql`
			INSERT INTO principal_identities (provider, subject, principal_id, source)
			VALUES ('discord', ${BOB}, ${kai.id}, 'self')`;
		clock += CACHE_MS - 1;
		expect(await host.principalOf(`discord:${BOB}`)).toBeUndefined();
		clock += 1;
		expect(await host.principalOf(`discord:${BOB}`)).toBe(kai.id);
	});

	test("logs ids only", async () => {
		const kai = await host.store.create({ displayName: "Kai Secret Name" });
		await links.link(kai.id, `discord:${KAI}`);
		await links.unlink(`discord:${KAI}`);
		const logged = lines.filter((line) => line.includes(kai.id));
		expect(logged).toHaveLength(2);
		for (const line of logged) {
			expect(line).toContain(`discord:${KAI}`);
			expect(line).not.toContain("Kai Secret Name");
		}
	});
});

test("the service is provided only with access.selfLink", () => {
	const without = identityPlugin({ rules: { ...RULES, selfLink: undefined } });
	expect(without.provides).toEqual([IDENTITY]);
	const withLinks = identityPlugin({ rules: RULES });
	expect(withLinks.provides).toEqual([IDENTITY, IDENTITY_LINKS]);
});

test("the rules refuse an empty list of providers, a blank one, and credentials as providers", () => {
	const withProviders = (providers: string[]) =>
		checkAccessRules({ ...RULES, selfLink: { providers } });
	expect(() => withProviders([])).toThrow(ConfigError);
	expect(() => withProviders([" "])).toThrow(/expected a provider/);
	expect(() => withProviders(["token"])).toThrow(/not a person's own account/);
	expect(() => withProviders(["legacy"])).toThrow(ConfigError);
	expect(withProviders(["discord"]).selfLink).toEqual({
		providers: ["discord"],
	});
});
