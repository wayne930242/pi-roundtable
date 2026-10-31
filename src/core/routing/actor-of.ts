import type { InboundMessage } from "../contract/channels.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { ActorFacts } from "../identity/actor-facts.ts";
import type { Logger } from "../log.ts";

/**
 * Who wrote the message, as its surface reports them; a surface that reports no `actor` has it
 * read from the author fields under its own name, once warned (`warned` holds the surfaces
 * already warned). None for a bot or an integration, unless the host lists the bot as a peer.
 */
export function actorOf(
	message: InboundMessage,
	warned: Set<string>,
	logger: Logger,
): ActorFacts | undefined {
	if ((message.authorIsBot && !message.peerBot) || message.integration)
		return undefined;
	if (message.actor) return message.actor;
	const { surface } = parseChannelKey(message.channel);
	if (!warned.has(surface)) {
		warned.add(surface);
		logger.warn(
			{ surface },
			`deprecated: the ${surface} surface reports no InboundMessage.actor, so its authors are read from authorId, authorName, and authorRoleIds as ${surface} identities; set actor, as this goes away in 1.0`,
		);
	}
	return {
		provider: surface,
		subject: message.authorId,
		name: message.authorName,
		surface,
		...(message.authorRoleIds
			? {
					roles: message.authorRoleIds.map((role) => `${surface}:role:${role}`),
				}
			: {}),
		...(message.space ? { space: message.space } : {}),
		legacyId: message.authorId,
	};
}
