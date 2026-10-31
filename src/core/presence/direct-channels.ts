import type { SurfacePort } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { Logger } from "../log.ts";
import { deliveryRouter } from "./delivery-router.ts";

/**
 * A way to reach a person on their own, such as a chat network's direct messages or a web inbox.
 * A plugin contributes it as `directChannels`; the host reaches a person for a piece of work
 * through a provider on the surface the work came from, and through another only when none there
 * reaches them (`DeliveryRouter`).
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
	 * The surface whose conversations it reaches, the key prefix of the channels `reaches` names,
	 * such as `"discord"` or the web app's `"app"`; work from a conversation on that surface reaches
	 * the person here first. Without it, its `name`.
	 */
	surface?: string;
	/**
	 * The person's own conversation here, where a notice to them is posted and where their
	 * schedules and delegated reports from a conversation no chat surface carries run; undefined
	 * when they have none here. It may reach the network and throw when that fails.
	 */
	reaches(principalId: string): Promise<ChannelKey | undefined>;
	/**
	 * Whether the person has a conversation here, from the host's own records such as their linked
	 * identities, without reaching the network. A session reads it when it decides whether to offer
	 * a tool that sends or runs there, so a network outage then does not take the tool away; the
	 * conversation itself is reached when the tool runs. Without it the host asks `reaches`.
	 */
	knows?(principalId: string): Promise<boolean>;
	/**
	 * Sends the person a notice here; without it the host posts the text in the channel `reaches`
	 * names, through the surface that serves it.
	 */
	deliver?(principalId: string, text: string): Promise<void>;
	/**
	 * Called with the notice after another provider delivered it, so this one can echo it, such as
	 * a web app pushing a prompt to a phone that Discord's direct message already reached. It runs
	 * only after a delivery, on every provider but the one that delivered, and only ever to the same
	 * person; its failure is logged and never changes what `notify` returns.
	 */
	mirror?(principalId: string, text: string): Promise<void>;
}

/** Where a person was reached: the provider, and their conversation on it. */
export interface DirectReach {
	provider: DirectChannelProvider;
	channel: ChannelKey;
}

/**
 * Every plugin's direct channels, as plugins and the core use them. Each lookup takes the origin of
 * the work, the conversation it came from, and goes through the delivery router: a provider on the
 * origin's surface first, another surface only when none there reaches the person. Each call before
 * the host links its plugins throws NotLinkedError, as for `conversations`.
 */
export interface DirectChannels {
	/** Every contributed provider, in contribution order; empty when no plugin contributes one. */
	providers(): readonly DirectChannelProvider[];
	/** The person's own conversation for work from `origin`; undefined when no provider reaches them. */
	reach(
		origin: ChannelKey,
		principalId: string,
	): Promise<DirectReach | undefined>;
	/**
	 * The provider that knows the person for work from `origin`, as `DirectChannelProvider.knows`
	 * tells without the network (or `reaches`, for a provider without it); undefined when none does.
	 */
	known(
		origin: ChannelKey,
		principalId: string,
	): Promise<DirectChannelProvider | undefined>;
	/**
	 * Sends the person `text` for work from `origin`, on its surface when a provider there reaches
	 * them; false when none anywhere does. A provider's failure, such as a network error, rejects.
	 */
	notify(
		origin: ChannelKey,
		principalId: string,
		text: string,
	): Promise<boolean>;
}

/** The direct channels over the providers the host linked, posting through its surfaces where a provider does not deliver itself. */
export function directChannelsPort(
	providers: () => readonly DirectChannelProvider[],
	surfaces: Pick<SurfacePort, "sendReply">,
	logger?: Pick<Logger, "warn">,
): DirectChannels {
	const router = deliveryRouter(providers, surfaces, logger);
	return {
		providers: () => providers(),
		reach: router.reach,
		known: router.known,
		notify: router.notify,
	};
}
