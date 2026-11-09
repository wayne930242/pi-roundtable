import type { Services } from "../contract/services.ts";
import { PluginError } from "../kernel/errors.ts";
import type { PluginContext, RoundtablePlugin } from "./plugin.ts";

/**
 * The context one plugin's setup gets: the host's parts and that plugin's view of the services.
 * `context.core` of 0.1.0 is gone; reading it throws a PluginError naming `context.services`, where
 * a plugin written for 0.1.0 meets it on its first line, instead of getting `undefined`.
 */
export function pluginContext(
	plugin: RoundtablePlugin,
	base: Omit<PluginContext, "services">,
	services: Services,
): PluginContext {
	// Every line a plugin logs carries its name.
	const context = {
		...base,
		logger: base.logger.child({ plugin: plugin.name }),
		services,
	};
	Object.defineProperty(context, "core", {
		enumerable: false,
		get() {
			throw new PluginError(
				`plugin ${plugin.name}: context.core was removed in 0.2.0; read a service with context.services.get(KEY), for example services.get(SCHEDULES), and provide one with services.provide(KEY, value) after listing KEY in the plugin's provides.`,
			);
		},
	});
	return context;
}
