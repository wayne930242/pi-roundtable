import type { SurfacePort } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { Notifier } from "../domain/ports.ts";
import { splitReply } from "../presentation/reply-splitter.ts";

/**
 * A way to reach a person on their own, such as a chat network's direct messages or a web inbox.
 * A plugin contributes it as `directChannels`; the host reaches a person through the first one,
 * in contribution order, that reaches them.
 */
export interface DirectChannelProvider {
	/** Unique across every plugin, such as `"discord"`. */
	name: string;
	/**
	 * How the `notify` tool names a message sent through it, completing "Send Ada …": such as
	 * `"a direct message on Discord"`.
	 */
	label: string;
	/**
	 * The person's own conversation here, where a notice to them is posted and where their
	 * schedules and delegated reports from a conversation no chat surface carries run; undefined
	 * when they have none here. It may reach the network and throw when that fails.
	 */
	reaches(principalId: string): Promise<ChannelKey | undefined>;
	/**
	 * Sends the person a notice here; without it the host posts the text in the channel `reaches`
	 * names, through the surface that serves it.
	 */
	deliver?(principalId: string, text: string): Promise<void>;
}

/** Where a person was reached: the provider, and their conversation on it. */
export interface DirectReach {
	provider: DirectChannelProvider;
	channel: ChannelKey;
}

/**
 * Every plugin's direct channels, as plugins and the core use them. Each call before the host
 * links its plugins throws NotLinkedError, as for `conversations`.
 */
export interface DirectChannels extends Notifier {
	/** Every contributed provider, in contribution order; empty when no plugin contributes one. */
	providers(): readonly DirectChannelProvider[];
	/** The person's own conversation on the first provider that reaches them; undefined when none does. */
	reach(principalId: string): Promise<DirectReach | undefined>;
	/**
	 * Sends the person `text` through the first provider that reaches them; false when none does.
	 * A provider's failure, such as a network error, rejects.
	 */
	notify(principalId: string, text: string): Promise<boolean>;
}

/** The direct channels over the providers the host linked, posting through its surfaces where a provider does not deliver itself. */
export function directChannelsPort(
	providers: () => readonly DirectChannelProvider[],
	surfaces: Pick<SurfacePort, "sendReply">,
): DirectChannels {
	const reach = async (
		principalId: string,
	): Promise<DirectReach | undefined> => {
		for (const provider of providers()) {
			const channel = await provider.reaches(principalId);
			if (channel !== undefined) return { provider, channel };
		}
		return undefined;
	};
	return {
		providers: () => providers(),
		reach,
		notify: async (principalId, text) => {
			const reached = await reach(principalId);
			if (!reached) return false;
			if (reached.provider.deliver)
				await reached.provider.deliver(principalId, text);
			else
				await surfaces.sendReply(reached.channel, {
					chunks: splitReply(text),
				});
			return true;
		},
	};
}
