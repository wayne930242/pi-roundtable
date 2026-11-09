import type { ServiceKey } from "../contract/services.ts";

/**
 * A service the plugin under test reads, with the members the test gives it, made by `servicePair(KEY,
 * { ... })`. Reading a member the test did not give throws a PluginError that names it.
 */
export interface ServicePair {
	readonly key: ServiceKey<unknown>;
	readonly given: object;
}

/** Pairs a service key with the members the test gives it, for the `services` option of `testPlugin`. */
export function servicePair<T extends object>(
	key: ServiceKey<T>,
	given: Partial<T>,
): ServicePair {
	return { key, given };
}
