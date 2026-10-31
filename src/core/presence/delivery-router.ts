import type { SurfacePort } from "../contract/surface.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { Logger } from "../log.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import type {
	DirectChannelProvider,
	DirectChannels,
	DirectReach,
} from "./direct-channels.ts";

/**
 * The conversation a piece of work came from: a turn's channel, a schedule's, a job's. Its surface
 * is the key's prefix, and everything the work sends goes there, or to the same person on that
 * surface, before any other.
 */
export type Origin = ChannelKey;

/** The surface an origin is on: the prefix of its key, such as `discord` or `app`. */
export function surfaceOf(origin: Origin): string {
	return parseChannelKey(origin).surface;
}

/** The surface whose conversations a provider reaches: its `surface`, else its name. */
export function providerSurface(provider: DirectChannelProvider): string {
	return provider.surface ?? provider.name;
}

/**
 * The one place that decides where a notice or run for a person goes, from the origin of the work.
 * A provider on the origin's surface is tried first; another surface is tried only when none there
 * reaches the person, and that fallback is logged with both surfaces. Mirroring is the provider's
 * own: after a delivery, each other provider that declares `mirror` echoes the notice to the same
 * person. Nothing here picks the "first" provider or the "most recent" conversation.
 */
export interface DeliveryRouter {
	/** The providers in the order an origin tries them: its own surface's, then the rest. */
	order(origin: Origin): readonly DirectChannelProvider[];
	/** The person's own conversation for work from `origin`; undefined when no provider reaches them. */
	reach(origin: Origin, principalId: string): Promise<DirectReach | undefined>;
	/** The provider that knows the person for `origin`, without the network where it can tell. */
	known(
		origin: Origin,
		principalId: string,
	): Promise<DirectChannelProvider | undefined>;
	/** Sends the person `text` for work from `origin`; false when no provider reaches them. */
	notify(origin: Origin, principalId: string, text: string): Promise<boolean>;
}

export function deliveryRouter(
	providers: () => readonly DirectChannelProvider[],
	surfaces: Pick<SurfacePort, "sendReply">,
	logger?: Pick<Logger, "warn">,
): DeliveryRouter {
	const order = (origin: Origin): readonly DirectChannelProvider[] => {
		const surface = surfaceOf(origin);
		const all = providers();
		return [
			...all.filter((p) => providerSurface(p) === surface),
			...all.filter((p) => providerSurface(p) !== surface),
		];
	};
	const fellBack = (
		origin: Origin,
		provider: DirectChannelProvider,
		principalId: string,
	): void => {
		const from = surfaceOf(origin);
		const to = providerSurface(provider);
		if (from !== to)
			logger?.warn(
				{ origin, from, to, principalId, provider: provider.name },
				"the origin's surface cannot reach the person; delivered on another surface",
			);
	};
	const reach = async (
		origin: Origin,
		principalId: string,
	): Promise<DirectReach | undefined> => {
		for (const provider of order(origin)) {
			const channel = await provider.reaches(principalId);
			if (channel === undefined) continue;
			fellBack(origin, provider, principalId);
			return { provider, channel };
		}
		return undefined;
	};
	const mirrored = async (
		delivered: DirectChannelProvider,
		principalId: string,
		text: string,
	): Promise<void> => {
		await Promise.all(
			providers()
				.filter((provider) => provider !== delivered && provider.mirror)
				.map(async (provider) => {
					try {
						await provider.mirror?.(principalId, text);
					} catch (error) {
						logger?.warn(
							{ err: error, provider: provider.name },
							"a direct channel did not mirror a notice",
						);
					}
				}),
		);
	};
	return {
		order,
		reach,
		known: async (origin, principalId) => {
			for (const provider of order(origin)) {
				const knows = provider.knows
					? await provider.knows(principalId)
					: (await provider.reaches(principalId)) !== undefined;
				if (knows) return provider;
			}
			return undefined;
		},
		notify: async (origin, principalId, text) => {
			const reached = await reach(origin, principalId);
			if (!reached) return false;
			if (reached.provider.deliver)
				await reached.provider.deliver(principalId, text);
			else
				await surfaces.sendReply(reached.channel, {
					chunks: splitReply(text),
				});
			await mirrored(reached.provider, principalId, text);
			return true;
		},
	};
}

/** What `runChannelFor` reads: the surfaces, the direct channels, and which claims take background turns. */
export interface RunChannelDeps {
	surfaces: Pick<SurfacePort, "of">;
	directChannels: Pick<DirectChannels, "reach">;
	takesBackground(channel: ChannelKey): boolean;
}

/**
 * The conversation a schedule's runs or a delegated job's report post in, for work created in
 * `origin`: the origin itself when a chat surface carries it; otherwise the creator's own
 * conversation the router reaches from that origin, which a claim must take background turns in.
 * Throws `refused` with why there is none.
 */
export async function runChannelFor(
	deps: RunChannelDeps,
	origin: Origin,
	principalId: string,
	refused: (message: string) => Error,
): Promise<ChannelKey> {
	if (deps.surfaces.of(origin)) return origin;
	const reached = await deps.directChannels.reach(origin, principalId);
	if (!reached)
		throw refused(
			"this conversation has no chat surface to post a run in, and you have no direct channel on this host to post it in instead",
		);
	if (!deps.takesBackground(reached.channel))
		throw refused(
			`this conversation has no chat surface to post a run in, and nothing here takes background turns in your ${reached.provider.name} direct messages, where it would go instead`,
		);
	return reached.channel;
}
