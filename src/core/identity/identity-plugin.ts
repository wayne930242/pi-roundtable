import type { RoundtablePlugin } from "../plugin.ts";
import { IDENTITY } from "../services.ts";
import type { AccessRules } from "./access-policy.ts";
import { type BackfillSummary, identityMigrations } from "./identity-schema.ts";
import { PgIdentityService } from "./identity-service.ts";
import { PgPrincipalStore } from "./principal-store.ts";

/** The name of the identity plugin, as the migration ledger names it. */
export const IDENTITY_PLUGIN = "identity";

export interface IdentityOptions {
	/** Who the host serves; the backfill makes the owners with a principal id first, by their names. */
	rules: AccessRules;
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
 * `IDENTITY`, its configured owners synced at setup. It runs first, so every later plugin may
 * read it.
 */
export function identityPlugin(options: IdentityOptions): RoundtablePlugin {
	const { rules } = options;
	const owners = rules.owners.flatMap((owner) =>
		owner.principal === undefined
			? []
			: [{ id: owner.principal, name: owner.name }],
	);
	let summary: BackfillSummary | undefined;
	return {
		name: IDENTITY_PLUGIN,
		migrations: identityMigrations(owners, (made) => {
			summary = made;
		}),
		provides: [IDENTITY],
		setup: async ({ database, services, logger }) => {
			if (summary) logger.info(backfillLine(summary));
			const identity = new PgIdentityService(
				await PgPrincipalStore.attach(database()),
				rules,
				{ logger },
			);
			await identity.syncConfig();
			services.provide(IDENTITY, identity);
			return {};
		},
	};
}
