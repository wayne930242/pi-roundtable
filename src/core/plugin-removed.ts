import type { ChatSurface } from "./contract/surface.ts";
import { PluginError } from "./errors.ts";
import type {
	Contribution,
	EventHandlers,
	RoundtablePlugin,
} from "./plugin.ts";

/**
 * The plugin fields of 0.1.0 that are gone, each with what replaces it. The host refuses a
 * plugin that still has one, so a plugin written for 0.1.0 fails at once instead of being ignored.
 */
const REMOVED_PLUGIN_FIELDS = {
	useCommands:
		"the composed slash commands go to the Discord plugin's surface, not to a plugin; add the commands from setup with context.services.get(DISCORD).commands.add(...), with DISCORD from pi-roundtable/discord",
	agentServer:
		"give the plugin a service with startInBackground, and hear how it ended in a serviceStarted event handler",
	stopTurn:
		"put stop(channel) on the channel claim that owns the channel; the router asks only the owning claim",
} as const;

/** The contribution parts of 0.1.0 that are gone, each with what replaces it. */
const REMOVED_PARTS = {
	interactions:
		"slash commands belong to the Discord plugin now; add them from setup with context.services.get(DISCORD).commands.add({ module, rootOptions }), with DISCORD from pi-roundtable/discord",
} as const;

/** The chat surface methods of 0.1.0 that are gone, each with what replaces it. */
const REMOVED_SURFACE_METHODS = {
	useCommands:
		"the host no longer composes slash commands or hands them to a surface; the Discord plugin composes them, and a plugin adds its own with context.services.get(DISCORD).commands.add(...) from pi-roundtable/discord",
} as const;

const REMOVED_EVENT = {
	agentServer:
		"hear serviceStarted instead, which names the plugin and service whose background start ended",
} as const;

/**
 * Refuses a plugin that still has a field of 0.1.0 that is gone, naming what replaces it, so it
 * fails where it is written or when the host links it instead of being ignored.
 */
export function refuseRemovedFields(plugin: RoundtablePlugin): void {
	for (const [field, replacement] of Object.entries(REMOVED_PLUGIN_FIELDS))
		if (field in plugin)
			throw new PluginError(
				`plugin ${plugin.name}: "${field}" was removed in 0.2.0; ${replacement}.`,
			);
}

/** Refuses a contribution part of 0.1.0 that is gone, naming what replaces it. */
export function refuseRemovedParts(
	plugin: string,
	contribution: Contribution,
): void {
	for (const [part, replacement] of Object.entries(REMOVED_PARTS))
		if (part in contribution)
			throw new PluginError(
				`plugin ${plugin}: the "${part}" part was removed in 0.2.0; ${replacement}.`,
			);
}

/** Refuses a chat surface that still has a method of 0.1.0 that is gone, naming what replaces it. */
export function refuseRemovedSurfaceMethods(
	plugin: string,
	surface: ChatSurface,
): void {
	for (const [method, replacement] of Object.entries(REMOVED_SURFACE_METHODS))
		if (method in surface)
			throw new PluginError(
				`plugin ${plugin}: surface ${surface.surface} has ${method}, which was removed in 0.2.0; ${replacement}.`,
			);
}

/** Refuses an event handler of 0.1.0 that is gone, naming what replaces it. */
export function refuseRemovedEvents(
	plugin: string,
	events: EventHandlers,
): void {
	for (const [event, replacement] of Object.entries(REMOVED_EVENT))
		if (event in events)
			throw new PluginError(
				`plugin ${plugin}: the "${event}" event was removed in 0.2.0; ${replacement}.`,
			);
}
