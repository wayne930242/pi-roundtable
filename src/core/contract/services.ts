/**
 * A typed name for a service one plugin provides and other plugins read. Two keys with one `id`
 * are the same service, so a key survives being imported through two copies of a package.
 */
export interface ServiceKey<T> {
	/** Unique across plugins, such as `"roundtable.schedules"` or `"my-notes.index"`. */
	readonly id: string;
	/** Type only; never set. Ties the key to the service it names, so keys of different services stay apart. */
	readonly __service?: () => T;
	/**
	 * What to tell a plugin that reads the service while no registered plugin provides it, such as
	 * how to switch the addon that provides it on. Without one the host gives its generic advice.
	 */
	readonly absent?: string;
}

/** Makes a key. The id is what the host matches on; give it a prefix of your own, such as your plugin's name. */
export function serviceKey<T>(
	id: string,
	options: { absent?: string } = {},
): ServiceKey<T> {
	if (typeof id !== "string" || id.trim() === "")
		throw new TypeError(
			`a service key needs an id, a non-empty string such as "my-notes.index"; got ${JSON.stringify(id)}.`,
		);
	return Object.freeze(
		options.absent === undefined ? { id } : { id, absent: options.absent },
	);
}

/** What a plugin provides and reads through `PluginContext.services`. */
export interface Services {
	/** The service, or throws a PluginError naming the key and the plugin to register first when it is not provided yet. */
	get<T>(key: ServiceKey<T>): T;
	/**
	 * The service, or undefined when no registered plugin declares it, such as an addon switched off.
	 * Throws like `get` when a plugin declares it but has not been set up yet: that is order, not absence.
	 */
	find<T>(key: ServiceKey<T>): T | undefined;
	/**
	 * A reader for a service whose plugin may be set up after this one: call it from a service's
	 * `start`, a handler, or any callback that runs after startup, not during setup, where it throws
	 * a NotLinkedError. The host checks before startup that a registered plugin provides the key and
	 * refuses to boot with a PluginError naming this plugin when none does.
	 */
	lazy<T>(key: ServiceKey<T>): () => T;
	/**
	 * Provides a service the plugin declares in `provides`; only while the plugin's setup runs, and
	 * once per key.
	 */
	provide<T>(key: ServiceKey<T>, value: T): void;
}
