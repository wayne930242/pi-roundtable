import type { RoundtablePlugin } from "../plugin.ts";
import { IDENTITY } from "../services.ts";
import {
	type BackfillOwner,
	type BackfillSummary,
	identityMigrations,
} from "./identity-schema.ts";
import { PgPrincipalStore } from "./principal-store.ts";

/** The name of the identity plugin, as the migration ledger names it. */
export const IDENTITY_PLUGIN = "identity";

export interface IdentityOptions {
	/** The configured owners whose principal id is known; the backfill makes them first, by these names. */
	owners: readonly BackfillOwner[];
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
 * principal of every person 0.8 stored, and the service over them provided as `IDENTITY`. It runs
 * first, so every later plugin may read it.
 */
export function identityPlugin(options: IdentityOptions): RoundtablePlugin {
	let summary: BackfillSummary | undefined;
	return {
		name: IDENTITY_PLUGIN,
		migrations: identityMigrations(options.owners, (made) => {
			summary = made;
		}),
		provides: [IDENTITY],
		setup: async ({ database, services, logger }) => {
			if (summary) logger.info(backfillLine(summary));
			services.provide(IDENTITY, {
				principals: await PgPrincipalStore.attach(database()),
			});
			return {};
		},
	};
}
