import type { PlaceProvider } from "../contract/places.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { PluginError } from "../kernel/errors.ts";

/**
 * Which plugin contributed the place provider of each surface, so two for one surface, a provider
 * that cannot work, and a provider for a surface nobody registers are refused naming the plugins.
 */
export class PlaceClaims {
	readonly #owners = new Map<string, string>();

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
		this.#owners.set(surface, plugin);
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
