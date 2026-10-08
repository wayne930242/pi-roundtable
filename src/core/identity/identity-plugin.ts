import type { RoundtablePlugin } from "../plugin.ts";
import { IDENTITY } from "../services.ts";
import type { AccessRules } from "./access-policy.ts";
import { type BackfillSummary, identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { identityView } from "./identity-view.ts";
import { declaredIdentities } from "./plugin-identities.ts";
import { PgPrincipalStore } from "./principal-store.ts";

/** The name of the identity plugin, as the migration ledger names it. */
export const IDENTITY_PLUGIN = "identity";

export interface IdentityOptions {
	/** Who the host serves; the backfill makes the owners with a principal id first, by their names, and caps what a carried-over author of schedules is seen at by the tiers. */
	rules: AccessRules;
	/** The host's other plugins, whose declared `identities` setup links; checked when this plugin is made. */
	plugins?: readonly RoundtablePlugin[];
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
 * setup. It runs first, so every later plugin may read it.
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
		provides: [IDENTITY],
		setup: async ({ database, services, logger }) => {
			if (summary) logger.info(backfillLine(summary));
			const identity = new PgIdentityService(
				await PgPrincipalStore.attach(database()),
				rules,
				{ logger, identities },
			);
			await identity.syncConfig();
			services.provide(IDENTITY, identityView(identity));
			return {};
		},
	};
}
