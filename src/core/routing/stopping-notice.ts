import type { InboundMessage } from "../contract/channels.ts";
import type { SurfacePort } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../kernel/log.ts";

/**
 * Tells the channel of a person's message the host does not answer because it shuts down: its
 * surface's `refuseStopping` may take it and tell the channel itself, such as leave it for the next
 * process; otherwise the channel is told once (`told`) to send it again. No one is told for a bot's
 * or an integration's message, such as a report, since a notice there would only start the next
 * one. Never rejects.
 */
export async function tellStopping(
	message: InboundMessage,
	surfaces:
		| (Pick<SurfacePort, "of"> & Partial<Pick<SurfacePort, "sendReply">>)
		| undefined,
	told: Set<ChannelKey>,
	logger: Logger,
): Promise<void> {
	const { channel } = message;
	if (message.authorIsBot || message.integration) return;
	try {
		if (await surfaces?.of(channel)?.refuseStopping?.(message)) return;
	} catch (error) {
		logger.warn(
			{ channel, err: error },
			"surface did not take a refused message",
		);
	}
	if (told.has(channel)) return;
	told.add(channel);
	await surfaces
		?.sendReply?.(channel, { chunks: [messages().restartingNotice] })
		.catch((error: unknown) =>
			logger.warn({ channel, err: error }, "restart notice not posted"),
		);
}
