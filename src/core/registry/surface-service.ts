import type { ChatSurface } from "../contract/surface.ts";
import type { PluginContext, Service } from "../plugin.ts";

/**
 * The surface as a service: it starts with the router's `handle` as its delivery, which drops
 * and logs a message that belongs to another prefix, and stops with the surface. It also passes the surface the router's
 * delete and edit events for its own channels.
 */
export function surfaceService(
	surface: ChatSurface,
	context: Pick<PluginContext, "logger" | "conversations">,
): Service {
	const { logger, conversations } = context;
	return {
		name: `surface:${surface.surface}`,
		start: () =>
			surface.start(
				(message) => {
					if (!message.channel.startsWith(`${surface.surface}:`)) {
						logger.error(
							{ surface: surface.surface, channel: message.channel },
							"a surface delivered a message of another prefix; dropped",
						);
						return;
					}
					void conversations.handle(message);
				},
				{
					deleted: (channel, messageId, space) => {
						if (!channel.startsWith(`${surface.surface}:`)) return;
						void conversations.messageDeleted?.(channel, messageId, space);
					},
					edited: (message) => {
						if (!message.channel.startsWith(`${surface.surface}:`)) return;
						void conversations.messageEdited?.(message);
					},
				},
			),
		...(surface.stop ? { stop: () => surface.stop?.() } : {}),
	};
}
