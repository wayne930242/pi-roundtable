import type { ChatSurface, SurfacePort } from "../contract/surface.ts";
import { parseChannelKey } from "../contract/surface.ts";
import { PluginError } from "../errors.ts";
import {
	isPromptScope,
	type PromptScope,
	promptScope,
} from "../interactions/prompts.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";

export interface SurfacePortOptions {
	/** Told when a caller uses a form that goes away, such as `prompts(channel, speaker)`. */
	deprecated?(message: string): void;
}

/**
 * The port over the contributed surfaces, each chosen by the prefix of a channel's key. `linked`
 * gives the surfaces once every plugin is set up and throws NotLinkedError before.
 */
export function surfacePort(
	linked: () => readonly ChatSurface[],
	options: SurfacePortOptions = {},
): SurfacePort {
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
		prompts: (channel, scope) =>
			of(channel)?.prompts?.(channel, scopeOf(scope, options)),
		interim: (channel) => of(channel)?.interim?.(channel),
		progress: async (channel, event) => {
			await of(channel)?.progress?.(channel, event);
		},
	};
}

/**
 * The scope a surface's prompts get: as given, or, from the 0.8 form's speaker, theirs in a
 * shared conversation, as 0.8 had them, with a warning.
 */
function scopeOf(
	given: PromptScope | Speaker | undefined,
	options: SurfacePortOptions,
): PromptScope | undefined {
	if (!given || isPromptScope(given)) return given;
	options.deprecated?.(
		"deprecated: prompts(channel, speaker) takes a PromptScope since 0.9, made with promptScope(speaker, visibility); a speaker is read as theirs in a shared conversation, and this form goes away in 1.0",
	);
	return promptScope(given);
}
