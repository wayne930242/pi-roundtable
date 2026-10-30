import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";

/** Tells the claim a message in its channel was deleted; a claim without the hook, or none, is skipped. Never rejects. */
export async function tellDeleted(
	claim: ChannelClaim | undefined,
	channel: ChannelKey,
	messageId: string,
	logger: Logger,
): Promise<void> {
	if (!claim?.onMessageDeleted) return;
	try {
		await claim.onMessageDeleted(channel, messageId);
	} catch (error) {
		logger.warn(
			{ channel, claim: claim.name, err: error },
			"a claim failed to handle a deleted message",
		);
	}
}

/**
 * Tells the claim a message in its channel was edited. Nobody is resolved or admitted for an edit,
 * so what only the router sets (`speaker`, `peerBot`) is dropped. Never rejects.
 */
export async function tellEdited(
	claim: ChannelClaim | undefined,
	given: InboundMessage,
	logger: Logger,
): Promise<void> {
	if (!claim?.onMessageEdited) return;
	const { peerBot: _peer, speaker: _speaker, ...message } = given;
	try {
		await claim.onMessageEdited(message);
	} catch (error) {
		logger.warn(
			{ channel: message.channel, claim: claim.name, err: error },
			"a claim failed to handle an edited message",
		);
	}
}
