import {
	CREATION_TOOL_ARGUMENTS,
	type PlaceProvider,
} from "../contract/places.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { PluginError } from "../kernel/errors.ts";

/**
 * Which plugin contributed the place provider of each surface, so two for one surface, a provider
 * that cannot work, and a provider for a surface nobody registers are refused naming the plugins.
 */
export class PlaceClaims {
	readonly #owners = new Map<string, string>();
	/** The plugin that added each creation-tool argument, by tool. */
	readonly #arguments = {
		agent: new Map<string, string>(),
		group: new Map<string, string>(),
	};

	claim(plugin: string, provider: PlaceProvider): void {
		const { surface } = provider;
		if (typeof surface !== "string" || surface === "" || /[:\s]/.test(surface))
			throw new PluginError(
				`plugin ${plugin}: a place provider is named by the surface whose keys its places have, a non-empty word without a colon or space, such as discord; got ${JSON.stringify(surface)}.`,
			);
		if (provider.storage !== "derived" && provider.storage !== "stored")
			throw new PluginError(
				`plugin ${plugin}: the place provider of surface ${surface} needs storage "derived" or "stored"; got ${JSON.stringify(provider.storage)}.`,
			);
		for (const member of ["key", "placeOf", "post"] as const)
			if (typeof provider[member] !== "function")
				throw new PluginError(
					`plugin ${plugin}: the place provider of surface ${surface} needs ${member}(), which every provider has.`,
				);
		const other = this.#owners.get(surface);
		if (other !== undefined)
			throw new PluginError(
				`plugin ${plugin}: surface ${surface} already has the place provider of plugin ${other}. Keep one provider per surface.`,
			);
		this.#claimArguments(plugin, provider);
		this.#owners.set(surface, plugin);
	}

	/** Refuses an argument a provider adds to a creation tool that the tool takes itself or another provider adds. */
	#claimArguments(plugin: string, provider: PlaceProvider): void {
		for (const tool of ["agent", "group"] as const) {
			const added = this.#arguments[tool];
			const own: readonly string[] = CREATION_TOOL_ARGUMENTS[tool];
			for (const name of Object.keys(provider.createArguments?.[tool] ?? {})) {
				const where = `plugin ${plugin}: the place provider of surface ${provider.surface} adds the argument ${name} to ${tool}_create`;
				if (own.includes(name))
					throw new PluginError(
						`${where}, which the tool takes itself. Name it otherwise.`,
					);
				const other = added.get(name);
				if (other !== undefined)
					throw new PluginError(
						`${where}, which the place provider of plugin ${other} adds already. Name it otherwise.`,
					);
				added.set(name, plugin);
			}
		}
	}

	/** Refuses a provider whose surface no plugin registered, once every plugin is set up. */
	check(surfaces: readonly ChatSurface[]): void {
		for (const [surface, plugin] of this.#owners)
			if (!surfaces.some((registered) => registered.surface === surface))
				throw new PluginError(
					`plugin ${plugin}: the place provider of surface ${surface}, which no plugin registers with \`surfaces\`. Contribute the surface, or remove the provider.`,
				);
	}
}
