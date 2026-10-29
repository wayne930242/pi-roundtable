import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { runMigrations } from "../db/migrations.ts";
import { IdentityError } from "../domain/errors.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext } from "../plugin.ts";
import { IDENTITY, PROFILES } from "../services.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import type { AccessRules } from "./access-policy.ts";
import type { ActorFacts } from "./actor-facts.ts";
import { identityPlugin } from "./identity-plugin.ts";
import type { IdentityService } from "./identity-service.ts";
import { PgIdentityService } from "./identity-service.ts";
import { PgPrincipalStore } from "./principal-store.ts";
import type { PersonProfiles, ProfileRules } from "./profiles.ts";

const ADA = "966666600000000001";
const ISSUER = "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20";
const NAME = "Line Kai Sample";
const PICTURE = "https://profile.line-scdn.net/private-picture-address";

const RULES: AccessRules = {
	owners: [{ name: "Ada", principal: ADA, identities: [`discord:${ADA}`] }],
	members: { everyone: ["line", "app"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

const lineFacts = {
	provider: "line",
	subject: "U1",
	name: "Facts Kai",
	surface: "line",
	legacyId: "line:U1",
} satisfies ActorFacts;

let db: ScratchDatabase;
let kai: string;

/** The identity plugin as a host runs it, over the scratch database, giving what it provides. */
async function boot(profiles?: ProfileRules) {
	const plugin = identityPlugin({
		rules: RULES,
		...(profiles ? { profiles } : {}),
	});
	const provided = new Map<string, unknown>();
	await runMigrations(db.sql, [plugin]);
	await plugin.setup?.({
		logger: silentLogger(),
		database: () => db.sql,
		services: {
			provide: (key: { id: string }, value: unknown) =>
				provided.set(key.id, value),
		},
	} as unknown as PluginContext);
	const profilesService = provided.get(PROFILES.id) as PersonProfiles;
	profilesService.register({
		provider: "line",
		label: "LINE",
		modelVisible: false,
		pictureHosts: ["profile.line-scdn.net"],
		fetch: async () => ({ name: NAME, pictureUrl: PICTURE }),
	});
	return {
		identity: provided.get(IDENTITY.id) as IdentityService,
		profiles: profilesService,
	};
}

describeDb("PROFILES through the identity plugin", () => {
	beforeAll(async () => {
		db = await scratchDatabase();
		// The tables exist before the people do, so a booting host finds them linked.
		const plugin = identityPlugin({ rules: RULES });
		await runMigrations(db.sql, [plugin]);
		const store = await PgPrincipalStore.attach(db.sql);
		const made = await store.create({ displayName: "Kai" });
		kai = made.id;
		await store.link(kai, { provider: "line", subject: "U1" }, "cli");
		await store.link(kai, { provider: "discord", subject: "D1" }, "cli");
		await store.link(kai, { provider: ISSUER, subject: "s1" }, "cli");
		await store.grant(kai, "member", "cli");
	});
	afterAll(async () => {
		await db.drop();
	});

	test("with no list in profiles.modelVisible, every name is as without profiles, whatever the source says", async () => {
		const { identity, profiles } = await boot();
		const plain = new PgIdentityService(
			await PgPrincipalStore.attach(db.sql),
			RULES,
			{ logger: silentLogger() },
		);
		expect(await identity.resolve(lineFacts)).toEqual(
			await plain.resolve(lineFacts),
		);
		expect(await identity.peek(lineFacts)).toEqual(await plain.peek(lineFacts));
		expect(await identity.speakerFor(kai)).toEqual(await plain.speakerFor(kai));
		expect((await identity.speakerFor(kai)).name).toBe("Kai");
		expect((await identity.resolve(lineFacts))?.name).toBe("Facts Kai");
		// The app can still show the name the source gave.
		await profiles.choose(kai, "line");
		expect((await profiles.of(kai)).name).toBe(NAME);
		await profiles.choose(kai, null);
	});

	test("a provider the host lists reaches Speaker.name through resolve, peek and speakerFor; one it does not list never does", async () => {
		const { identity, profiles } = await boot({
			prefer: ["line"],
			modelVisible: ["line"],
		});
		expect(await profiles.sourceOf(kai)).toBe("line");
		expect((await identity.resolve(lineFacts))?.name).toBe(NAME);
		expect((await identity.peek(lineFacts))?.name).toBe(NAME);
		expect((await identity.speakerFor(kai)).name).toBe(NAME);
		// The same person chose Discord, which the host does not list: their facts' name stays.
		await profiles.choose(kai, "discord");
		expect((await identity.resolve(lineFacts))?.name).toBe("Facts Kai");
		expect((await identity.speakerFor(kai)).name).toBe("Kai");
		await profiles.choose(kai, null);
		expect((await identity.speakerFor(kai)).name).toBe(NAME);
	});

	test("a name a sign-in reported is the speaker's name when its provider is listed, and the display name otherwise", async () => {
		const listed = await boot({ prefer: [ISSUER], modelVisible: [ISSUER] });
		listed.profiles.observed(kai, ISSUER, "Kai From The Claim");
		const facts = { ...lineFacts, provider: ISSUER, subject: "s1" };
		expect((await listed.identity.peek(facts))?.name).toBe(
			"Kai From The Claim",
		);
		const unlisted = await boot({ prefer: [ISSUER], modelVisible: [] });
		unlisted.profiles.observed(kai, ISSUER, "Kai From The Claim");
		expect((await unlisted.identity.peek(facts))?.name).toBe("Facts Kai");
		expect((await unlisted.profiles.of(kai)).name).toBe("Kai From The Claim");
	});

	test("choose refuses a provider the person has not linked, stores the choice, and null returns to the default", async () => {
		const { profiles } = await boot({ prefer: ["line"], modelVisible: [] });
		expect(profiles.choose(kai, "github")).rejects.toThrow(IdentityError);
		expect(profiles.choose("p_missing", "line")).rejects.toThrow(
			"there is no principal p_missing",
		);
		await profiles.choose(kai, "discord");
		expect(await profiles.sourceOf(kai)).toBe("discord");
		const rows = await db.sql`SELECT * FROM principal_profile_choices`;
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]).sort()).toEqual([
			"chosen_at",
			"principal_id",
			"provider",
		]);
		// A later boot reads the stored choice.
		const later = await boot({ prefer: ["line"], modelVisible: [] });
		expect(await later.profiles.sourceOf(kai)).toBe("discord");
		await later.profiles.choose(kai, null);
		expect(await later.profiles.sourceOf(kai)).toBe("line");
		expect(await db.sql`SELECT * FROM principal_profile_choices`).toHaveLength(
			0,
		);
	});

	test("a choice whose link is gone is ignored, and a person with no choice and no preferred link is shown by the display name", async () => {
		const { profiles } = await boot({ prefer: ["github"], modelVisible: [] });
		expect(await profiles.sourceOf(kai)).toBeUndefined();
		expect(await profiles.of(kai)).toEqual({ name: "Kai", picture: false });
		await db.sql`INSERT INTO principal_profile_choices (principal_id, provider) VALUES (${kai}, 'github')`;
		const later = await boot({ prefer: ["github"], modelVisible: [] });
		expect(await later.profiles.sourceOf(kai)).toBeUndefined();
		await db.sql`DELETE FROM principal_profile_choices`;
	});

	test("what plugins get carries no way to the name agents read, and a second source for a provider is refused", async () => {
		const { profiles } = await boot();
		expect(Object.keys(profiles).sort()).toEqual([
			"choose",
			"observed",
			"of",
			"picture",
			"register",
			"sourceOf",
			"sources",
		]);
		expect(Object.isFrozen(profiles)).toBe(true);
		expect(Object.isFrozen(await profiles.of(kai))).toBe(true);
		expect(() =>
			profiles.register({
				provider: "line",
				label: "Again",
				modelVisible: false,
				pictureHosts: [],
				fetch: async () => undefined,
			}),
		).toThrow("already registered");
		expect(profiles.sources()).toEqual([{ provider: "line", label: "LINE" }]);
	});

	test("no name and no picture address is written to any table", async () => {
		const { identity, profiles } = await boot({
			prefer: ["line"],
			modelVisible: ["line"],
		});
		await profiles.choose(kai, "line");
		await identity.resolve(lineFacts);
		await identity.speakerFor(kai);
		await profiles.of(kai);
		const sql: SQL = db.sql;
		const tables: { table_name: string }[] = await sql`
			SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
		expect(tables.length).toBeGreaterThan(4);
		for (const { table_name } of tables) {
			const rows: { row: string }[] = await sql.unsafe(
				`SELECT t::text AS row FROM "${table_name}" t`,
			);
			for (const { row } of rows) {
				expect(row).not.toContain(NAME);
				expect(row).not.toContain("line-scdn");
			}
		}
		await profiles.choose(kai, null);
	});
});
