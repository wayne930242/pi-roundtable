import type { RoundtablePlugin } from "../plugin.ts";
import { CHANNEL_CONTEXT } from "../services.ts";

/**
 * The channel context of every surface that reads it. The plugin provides one `CHANNEL_CONTEXT`
 * service that picks the surface by the message's channel key, as the `threads` plugin does for
 * dispatch threads, and asks its `channelContext`; a surface without one answers undefined.
 */
export function channelContextPlugin(): RoundtablePlugin {
	return {
		name: "channel-context",
		provides: [CHANNEL_CONTEXT],
		setup: ({ surfaces, services }) => {
			services.provide(CHANNEL_CONTEXT, {
				read: async (message, options) =>
					surfaces.of(message.channel)?.channelContext?.(message, options),
			});
			return {};
		},
	};
}
