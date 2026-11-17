import { type Client, Events } from "discord.js";
import type { InboundMessage } from "../contract/channels.ts";
import type { SurfaceMessageEvents } from "../contract/surface.ts";
import { channelKey } from "../contract/surface.ts";
import type { Logger } from "../kernel/log.ts";
import { toInbound } from "./inbound-message.ts";

/** Decides whether a message the gateway delivered is handed on: false keeps it from routing. */
export type InboundGate = (
	message: InboundMessage,
	botId: string,
) => Promise<boolean>;

/**
 * Hands every message the client sees to `deliver` as the neutral message, in the order each
 * channel's messages came, however long reading one takes; the bot's own are left out, and so is
 * one the gate refuses.
 */
export function listenForMessages(
	client: Client,
	deliver: (message: InboundMessage) => void,
	logger: Logger,
	gate?: InboundGate,
): void {
	const delivering = new Map<string, Promise<void>>();
	client.on(Events.MessageCreate, (message) => {
		const botId = client.user?.id;
		const read = toInbound(message, {
			botId,
			applicationId: client.application?.id,
		}).then(async (inbound) => {
			if (!inbound || !botId) return undefined;
			return !gate || (await gate(inbound, botId)) ? inbound : undefined;
		});
		const { channelId } = message;
		const after = (delivering.get(channelId) ?? Promise.resolve())
			.then(() => read)
			.then((inbound) => {
				if (inbound) deliver(inbound);
			})
			.catch((error: unknown) =>
				logger.error({ err: error }, "inbound message could not be read"),
			);
		delivering.set(channelId, after);
		void after.then(() => {
			if (delivering.get(channelId) === after) delivering.delete(channelId);
		});
	});
}

/**
 * Reports deleted and edited messages to the claims. The partial-message setting of the client
 * lets a delete or an edit of a message it never cached arrive; an edit of one is fetched to read
 * it. A delete carries only ids, so it is reported for the bot's own messages too.
 */
export function reportChanges(
	client: Client,
	events: SurfaceMessageEvents,
	logger: Logger,
): void {
	const deleted = (channelId: string, id: string, guildId: string | null) =>
		events.deleted(channelKey("discord", channelId), id, guildId ?? undefined);
	client.on(Events.MessageDelete, (message) =>
		deleted(message.channelId, message.id, message.guildId),
	);
	client.on(Events.MessageBulkDelete, (messages, channel) => {
		for (const id of messages.keys()) deleted(channel.id, id, channel.guildId);
	});
	client.on(Events.MessageUpdate, (before, after) => {
		void (async () => {
			const current = after.partial ? await after.fetch() : after;
			// An unfurled link, a pin or an edit by the bot itself is not what a claim keeps track of.
			if (
				!before.partial &&
				before.content === current.content &&
				before.embeds.length === current.embeds.length &&
				before.attachments.size === current.attachments.size
			)
				return;
			const inbound = await toInbound(current, {
				botId: client.user?.id,
				applicationId: client.application?.id,
			});
			if (inbound) events.edited(inbound);
		})().catch((error: unknown) =>
			logger.warn({ err: error }, "an edited message could not be read"),
		);
	});
}
