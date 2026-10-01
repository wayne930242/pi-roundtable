import type { ServiceKey, Services } from "../contract/services.ts";
import { NotLinkedError, PluginError } from "../errors.ts";
import type { RoundtablePlugin } from "../plugin.ts";

/** The host's words for reading a service no plugin declares; `testPlugin` says how to give one instead. */
const HOST_ADVICE =
	"Register a plugin that provides it, before the plugin that reads it.";

/** The services a plugin declares, checked before any setup: each a key with an id, once per plugin. */
function declaredBy(plugin: RoundtablePlugin): readonly ServiceKey<unknown>[] {
	const { provides } = plugin;
	if (provides === undefined) return [];
	if (!Array.isArray(provides))
		throw new PluginError(
			`plugin ${plugin.name}: provides must be a list of service keys made with serviceKey().`,
		);
	const seen = new Set<string>();
	for (const key of provides) {
		if (typeof key?.id !== "string" || key.id === "")
			throw new PluginError(
				`plugin ${plugin.name}: provides has an entry that is not a service key; make each with serviceKey("<id>").`,
			);
		if (seen.has(key.id))
			throw new PluginError(
				`plugin ${plugin.name}: provides lists service ${key.id} twice.`,
			);
		seen.add(key.id);
	}
	return provides;
}

/** The services a plugin requires, checked to be a list of keys; empty when it requires none. */
function requiredBy(plugin: RoundtablePlugin): readonly ServiceKey<unknown>[] {
	const { requires } = plugin;
	if (requires === undefined) return [];
	if (!Array.isArray(requires))
		throw new PluginError(
			`plugin ${plugin.name}: requires must be a list of service keys made with serviceKey().`,
		);
	for (const key of requires)
		if (typeof key?.id !== "string" || key.id === "")
			throw new PluginError(
				`plugin ${plugin.name}: requires has an entry that is not a service key; make each with serviceKey("<id>").`,
			);
	return requires;
}

/** The services a plugin replaces, checked to be a list of keys; empty when it replaces none. */
function replacedBy(plugin: RoundtablePlugin): readonly ServiceKey<unknown>[] {
	const { replaces } = plugin;
	if (replaces === undefined) return [];
	if (!Array.isArray(replaces))
		throw new PluginError(
			`plugin ${plugin.name}: replaces must be a list of service keys made with serviceKey().`,
		);
	for (const key of replaces)
		if (typeof key?.id !== "string" || key.id === "")
			throw new PluginError(
				`plugin ${plugin.name}: replaces has an entry that is not a service key; make each with serviceKey("<id>").`,
			);
	return replaces;
}

/**
 * Applies every plugin's `replaces`: the plugin that provides a replaced service is dropped and
 * the replacement is set up where it stood. Refuses a key nobody provides, a key two plugins
 * replace, a replacement that does not declare what it replaces, and a partial replacement, where
 * the dropped plugin provides a service the replacement does not.
 */
export function replaceServices(
	plugins: readonly RoundtablePlugin[],
): RoundtablePlugin[] {
	const replacers = plugins.filter((plugin) => replacedBy(plugin).length > 0);
	if (replacers.length === 0) return [...plugins];
	// Only a plugin that does not replace can be the one replaced.
	const providerOf = new Map<string, RoundtablePlugin>();
	for (const plugin of plugins)
		if (!replacers.includes(plugin))
			for (const key of declaredBy(plugin))
				if (!providerOf.has(key.id)) providerOf.set(key.id, plugin);
	const claimed = new Map<string, RoundtablePlugin>();
	const dropped = new Map<RoundtablePlugin, RoundtablePlugin>();
	for (const plugin of replacers) {
		const own = new Set(declaredBy(plugin).map((key) => key.id));
		for (const key of replacedBy(plugin)) {
			const other = claimed.get(key.id);
			if (other)
				throw new PluginError(
					`plugin ${plugin.name}: service ${key.id} is also replaced by plugin ${other.name}. Keep one replacement per service.`,
				);
			claimed.set(key.id, plugin);
			if (!own.has(key.id))
				throw new PluginError(
					`plugin ${plugin.name}: replaces service ${key.id} but does not list it in provides. Provide what you replace.`,
				);
			const provider = providerOf.get(key.id);
			if (!provider)
				throw new PluginError(
					`plugin ${plugin.name}: replaces service ${key.id}, which no other registered plugin provides. Remove it from replaces, or register the plugin that provides it.`,
				);
			dropped.set(provider, plugin);
		}
	}
	for (const [provider, replacement] of dropped) {
		const replaced = new Set(replacedBy(replacement).map((key) => key.id));
		const missing = declaredBy(provider).filter((key) => !replaced.has(key.id));
		if (missing.length > 0)
			throw new PluginError(
				`plugin ${replacement.name}: replacing plugin ${provider.name} would drop ${missing.map((key) => key.id).join(", ")} too, which it also provides. Replace every service of ${provider.name}, or none.`,
			);
	}
	// The replacement takes the place of the first plugin it drops, not the place it was listed in.
	const result: RoundtablePlugin[] = [];
	for (const plugin of plugins) {
		if (replacers.includes(plugin)) continue;
		const replacement = dropped.get(plugin);
		if (!replacement) result.push(plugin);
		else if (!result.includes(replacement)) result.push(replacement);
	}
	return result;
}

/** What to do about a service whose provider has not set up yet: the order the plugins are registered in. */
function orderHint(
	provider: RoundtablePlugin,
	reader: RoundtablePlugin | undefined,
): string {
	if (reader === undefined) return "";
	if (reader === provider)
		return ` Plugin ${provider.name} reads it before its own setup has provided it.`;
	return ` Register plugin ${provider.name} before plugin ${reader.name}.`;
}

/**
 * The services the plugins provide and read. It knows from `provides` which plugin declares each
 * key before any setup, so a read can tell a service switched off from one that is not set up yet.
 */
export class ServiceRegistry {
	readonly #declaredBy = new Map<string, RoundtablePlugin>();
	readonly #values = new Map<string, unknown>();
	readonly #advice: string;
	/** The plugin whose setup is running, the only one that may provide. */
	#setting: RoundtablePlugin | undefined;
	/** The plugins that have read a service, such as one that adds its commands through it. */
	readonly #readers = new Set<RoundtablePlugin>();
	readonly #plugins: readonly RoundtablePlugin[];
	/** What each plugin asked `lazy` for, to refuse a key nobody provides once every plugin is set up. */
	readonly #lazy: { plugin: RoundtablePlugin; key: ServiceKey<unknown> }[] = [];
	/** Whether every plugin is set up, from which a `lazy` reader returns its service. */
	#settled = false;

	/** `advice` says how to get a service no plugin declares; the host's is to register one that does. */
	constructor(plugins: readonly RoundtablePlugin[], advice = HOST_ADVICE) {
		this.#advice = advice;
		this.#plugins = plugins;
		for (const plugin of plugins)
			for (const key of declaredBy(plugin)) {
				const other = this.#declaredBy.get(key.id);
				if (other)
					throw new PluginError(
						`plugin ${plugin.name}: service ${key.id} is also provided by plugin ${other.name}. Keep one provider, or have one plugin replace the other with replaces.`,
					);
				this.#declaredBy.set(key.id, plugin);
			}
	}

	/** Provides a service the host or a test holds itself, without a plugin's setup. */
	preset<T>(key: ServiceKey<T>, value: T): void {
		this.#values.set(key.id, value);
	}

	/**
	 * Refuses a plugin whose `requires` names a service no registered plugin or test provides, or
	 * one a plugin registered after it provides. It runs before any migration or setup, so a wrong
	 * order fails at the start with both plugins named.
	 */
	checkRequires(): void {
		this.#plugins.forEach((plugin, index) => {
			for (const key of requiredBy(plugin)) {
				if (this.#values.has(key.id)) continue;
				const provider = this.#declaredBy.get(key.id);
				if (!provider)
					throw new PluginError(
						`plugin ${plugin.name}: requires service ${key.id}, which no registered plugin provides. ${key.absent ?? this.#advice}`,
					);
				if (provider === plugin)
					throw new PluginError(
						`plugin ${plugin.name}: requires service ${key.id}, which it provides itself. A plugin cannot require what it provides.`,
					);
				if (this.#plugins.indexOf(provider) > index)
					throw new PluginError(
						`plugin ${plugin.name}: requires service ${key.id}, which plugin ${provider.name} provides after it. Register plugin ${provider.name} before plugin ${plugin.name}, or read the service with services.lazy(KEY) from a callback that runs after startup.`,
					);
			}
		});
	}

	/**
	 * Called once every plugin is set up: `lazy` readers start answering, and a key a plugin asked
	 * for that nobody provides is refused with the plugin named.
	 */
	settle(): void {
		for (const { plugin, key } of this.#lazy)
			if (!this.#values.has(key.id))
				throw new PluginError(
					`plugin ${plugin.name}: services.lazy reads service ${key.id}, which no registered plugin provides. ${key.absent ?? this.#advice}`,
				);
		this.#settled = true;
	}

	/** The service, for the host's own reads; throws like a plugin's `get`. */
	get<T>(key: ServiceKey<T>): T {
		return this.#read(key, undefined, true) as T;
	}

	find<T>(key: ServiceKey<T>): T | undefined {
		return this.#read(key, undefined, false);
	}

	#read<T>(
		key: ServiceKey<T>,
		reader: RoundtablePlugin | undefined,
		required: boolean,
	): T | undefined {
		if (this.#values.has(key.id)) return this.#values.get(key.id) as T;
		const provider = this.#declaredBy.get(key.id);
		if (provider) {
			throw new PluginError(
				`service ${key.id} is not provided yet; plugin ${provider.name} provides it.${orderHint(provider, reader)}`,
			);
		}
		if (!required) return undefined;
		throw new PluginError(
			`service ${key.id} is not provided. ${key.absent ?? this.#advice}`,
		);
	}

	/** The view one plugin's setup gets: its reads name it, and only it may provide what it declares. */
	forPlugin(plugin: RoundtablePlugin): Services {
		return {
			get: <T>(key: ServiceKey<T>) => {
				this.#readers.add(plugin);
				return this.#read(key, plugin, true) as T;
			},
			find: <T>(key: ServiceKey<T>) => {
				this.#readers.add(plugin);
				return this.#read(key, plugin, false);
			},
			lazy: <T>(key: ServiceKey<T>) => {
				this.#readers.add(plugin);
				this.#lazy.push({ plugin, key });
				return () => {
					if (!this.#settled)
						throw new NotLinkedError(
							`service ${key.id} is read through lazy() once every plugin is set up. Call it from a service's start or from a handler, not during setup.`,
						);
					return this.#values.get(key.id) as T;
				};
			},
			provide: (key, value) => {
				if (this.#setting !== plugin)
					throw new PluginError(
						`plugin ${plugin.name}: services are provided from setup only; provide ${key.id} while setup runs.`,
					);
				if (this.#declaredBy.get(key.id) !== plugin)
					throw new PluginError(
						`plugin ${plugin.name}: cannot provide service ${key.id}, which it does not declare. Add it to the plugin's provides.`,
					);
				if (this.#values.has(key.id))
					throw new PluginError(
						`plugin ${plugin.name}: service ${key.id} is provided twice.`,
					);
				this.#values.set(key.id, value);
			},
		};
	}

	/** Whether the plugin read a service: it then works through that service, even when it returns no part. */
	reads(plugin: RoundtablePlugin): boolean {
		return this.#readers.has(plugin);
	}

	/** Runs a plugin's setup with `provide` open to it, and refuses it when it declared a service it did not provide. */
	async setUp<T>(
		plugin: RoundtablePlugin,
		setup: () => Promise<T> | T,
	): Promise<T> {
		this.#setting = plugin;
		try {
			const result = await setup();
			for (const key of declaredBy(plugin))
				if (!this.#values.has(key.id))
					throw new PluginError(
						`plugin ${plugin.name}: declares that it provides service ${key.id}, but setup did not provide it. Call services.provide(...) in setup, or remove it from provides.`,
					);
			return result;
		} finally {
			this.#setting = undefined;
		}
	}
}
