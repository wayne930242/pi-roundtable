import type { ChatSurface, SurfacePort } from "../contract/surface.ts";
import { parseChannelKey } from "../contract/surface.ts";
import { PluginError } from "../errors.ts";
import type { ChannelKey } from "../sessions.ts";

/**
 * The port over the contributed surfaces, each chosen by the prefix of a channel's key. `linked`
 * gives the surfaces once every plugin is set up and throws NotLinkedError before.
 */
export function surfacePort(linked: () => readonly ChatSurface[]): SurfacePort {
	const of = (channel: ChannelKey): ChatSurface | undefined => {
		const at = channel.indexOf(":");
		if (at <= 0) return undefined;
		const prefix = channel.slice(0, at);
		return linked().find((surface) => surface.surface === prefix);
	};
	const served = (channel: ChannelKey): ChatSurface => {
		const surface = of(channel);
		if (!surface)
			throw new PluginError(
				`no chat surface serves "${parseChannelKey(channel).surface}" channels, such as ${channel}. A plugin contributes one with \`surfaces\`.`,
			);
		return surface;
	};
	return {
		of,
		sendReply: async (channel, reply) => {
			const surface = served(channel);
			if (reply.files?.length && surface.supportsFiles !== true)
				throw new PluginError(
					`surface ${surface.surface} does not support reply files; declare supportsFiles: true and deliver every file in sendReply.`,
				);
			await surface.sendReply(channel, reply);
		},
		startTyping: (channel) =>
			of(channel)?.startTyping?.(channel) ?? (() => undefined),
		showStop: (channel) =>
			of(channel)?.showStop?.(channel) ?? (() => undefined),
		react: async (channel, messageId, emoji) =>
			of(channel)?.react?.(channel, messageId, emoji),
		unreact: async (channel, messageId, emoji) =>
			of(channel)?.unreact?.(channel, messageId, emoji),
		prompts: (channel, speaker) => of(channel)?.prompts?.(channel, speaker),
	};
}
