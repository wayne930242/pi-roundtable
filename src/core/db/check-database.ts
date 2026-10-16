import type { SQL } from "bun";

const REFUSAL =
	"the database was queried during setup, which `Roundtable.check()` does not migrate or connect. Open stores lazily, and query from a service's start or from a handler";

function refuse(): never {
	throw new Error(REFUSAL);
}

/**
 * The database a plugin's setup sees under `check()`: a pool that exists, so a store can attach to
 * it, but that refuses every query, transaction and connection. A refusal reaches the plugin as an
 * ordinary setup error, which the host words with the plugin's name.
 */
export function checkDatabase(): SQL {
	// SAFETY: the stand-in answers the members of SQL a plugin could reach during setup, all by refusing.
	const stand = new Proxy(refuse, {
		apply: refuse,
		// Not awaitable and no other symbol, so returning it from an async setup or logging it is harmless.
		get: (_target, property) =>
			property === STAND_IN
				? true
				: typeof property === "symbol" || property === "then"
					? undefined
					: refuse,
	}) as unknown as SQL;
	return stand;
}

const STAND_IN = Symbol("roundtable.checkDatabase");

/**
 * Whether `sql` is the stand-in `check()` hands the plugins. The built-in plugins whose setup would
 * otherwise write to the database, such as the identity plugin's configuration sync, skip that
 * write under it: `check()` proves the registration, not the data.
 */
export function isCheckDatabase(sql: SQL): boolean {
	return (sql as unknown as Record<symbol, unknown>)[STAND_IN] === true;
}
