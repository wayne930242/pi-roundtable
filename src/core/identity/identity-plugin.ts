import { isCheckDatabase } from "../db/check-database.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { IDENTITY, IDENTITY_LINKS, PROFILES } from "../services.ts";
import type { AccessRules } from "./access-policy.ts";
import { identityLinks } from "./identity-links.ts";
import { type BackfillSummary, identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { identityView } from "./identity-view.ts";
import { PersonDirectory } from "./person-profiles.ts";
import { declaredIdentities } from "./plugin-identities.ts";
import { PgPrincipalStore } from "./principal-store.ts";
import type { ProfileRules } from "./profiles.ts";
import { profilesView } from "./profiles-view.ts";

/** The name of the identity plugin, as the migration ledger names it. */
export const IDENTITY_PLUGIN = "identity";

export interface IdentityOptions {
	/** Who the host serves; the backfill makes the owners with a principal id first, by their names, and caps what a carried-over author of schedules is seen at by the tiers. */
	rules: AccessRules;
	/** The host's other plugins, whose declared `identities` setup links; checked when this plugin is made. */
	plugins?: readonly RoundtablePlugin[];
	/** How people are named: the providers that name a person who has not chosen, and those whose names agents may read. Default none. */
	profiles?: ProfileRules;
}

/** One line for the log: what the boot's backfill made, and from where. */
export function backfillLine(summary: BackfillSummary): string {
	const sources = Object.entries(summary.sources)
		.map(([source, count]) => `${source} ${count}`)
		.join(", ");
	return `principal backfill: ${summary.created} created; ids found: ${sources}`;
}

/**
 * The principals, their identity links, and their roles: the tables, the backfill that makes a
 * principal of every person 0.8 stored, and the identity service over them provided as
 * `IDENTITY`, read-only, its configured owners and the plugins' declared identities synced at
 * setup. It provides `PROFILES` too, the names and pictures of the people, and, when the rules
 * list `selfLink` providers, `IDENTITY_LINKS`. It runs first, so every later plugin may read them.
 */
export function identityPlugin(options: IdentityOptions): RoundtablePlugin {
	const { rules } = options;
	const identities = declaredIdentities(options.plugins ?? []);
	let summary: BackfillSummary | undefined;
	return {
		name: IDENTITY_PLUGIN,
		migrations: identityMigrations(rules, (made) => {
			summary = made;
		}),
		provides: rules.selfLink
			? [IDENTITY, PROFILES, IDENTITY_LINKS]
			: [IDENTITY, PROFILES],
		setup: async ({ database, services, logger }) => {
			if (summary) logger.info(backfillLine(summary));
			const sql = database();
			const identity = new PgIdentityService(
				await PgPrincipalStore.attach(sql),
				rules,
				{
					logger,
					identities,
					profiles: { modelName: (id) => directory.modelName(id) },
				},
			);
			const directory = new PersonDirectory({
				sql,
				rules: options.profiles ?? { prefer: [], modelVisible: [] },
				logger,
				links: {
					identities: (id) => identity.store.identitiesOf(id),
					displayName: async (id) =>
						(await identity.store.get(id))?.displayName,
				},
			});
			// `Roundtable.check()` has no database to write the configured principals to: it asks
			// only what the configuration and the declared identities settle without one.
			if (isCheckDatabase(sql)) identity.checkConfig();
			else await identity.syncConfig();
			services.provide(IDENTITY, identityView(identity));
			services.provide(PROFILES, profilesView(directory));
			if (rules.selfLink)
				services.provide(
					IDENTITY_LINKS,
					identityLinks(identity.store, rules.selfLink, logger),
				);
			return {};
		},
	};
}
