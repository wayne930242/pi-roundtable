import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ConversationRecord } from "../../conversations/conversation-registry.ts";
import { SYSTEM_PRINCIPAL } from "../../identity/principal-store.ts";
import type { OwnerIdentity } from "../../identity.ts";
import type { Logger } from "../../log.ts";
import type {
	DirectChannelProvider,
	DirectChannels,
} from "../../presence/direct-channels.ts";
import type { SessionContext } from "../../sessions.ts";
import { notifyExtension } from "./notify.ts";

export interface SessionNotifyDeps {
	directChannels: DirectChannels;
	/** The host's record of a session's conversation; undefined for an agent's, or one it has no record of. */
	recordOf(session: SessionContext): Promise<ConversationRecord | undefined>;
	/** The primary owner: the host's own turns, such as a report's, notify them, as 0.8 did. */
	owner: OwnerIdentity & { id: string };
	logger: Logger;
}

/** "a direct message on Discord", or each provider's label joined with "or". */
function labels(providers: readonly DirectChannelProvider[]): string {
	return providers.map((provider) => provider.label).join(" or ");
}

/**
 * The notify tool of each session: none on a host without direct channels, and none in a private
 * conversation whose person no direct channel reaches. A notice goes to the conversation's
 * person in a private one, and to the turn's speaker in a shared one.
 */
export function sessionNotify(
	deps: SessionNotifyDeps,
): (session: SessionContext) => ExtensionFactory | null {
	const { directChannels, owner, logger } = deps;
	// Whom a notice is for: the person of a private conversation, the speaker of a shared one; the
	// host's own turns notify the conversation's person, or else the primary owner. Anyone else
	// speaking in someone's private conversation is refused, so their text never reaches its person.
	const recipientOf = (
		session: SessionContext,
		own: string | undefined,
	): { principalId: string } | { refused: string } => {
		const speaker = session.speaker();
		if (!speaker)
			return {
				refused:
					"a notice is sent only in a turn someone is named for, whose notice it is",
			};
		if (speaker.principalId === SYSTEM_PRINCIPAL)
			return { principalId: own ?? owner.id };
		if (own !== undefined && speaker.principalId !== own)
			return {
				refused:
					"this conversation is private to someone else, so a notice here is not yours to send",
			};
		return { principalId: speaker.principalId };
	};
	return (session) => {
		const providers = directChannels.providers();
		if (providers.length === 0) return null;
		return async (pi) => {
			const record = await deps.recordOf(session);
			const own =
				record?.visibility === "private" ? record.principalId : undefined;
			let reaching = providers;
			if (own !== undefined) {
				try {
					const known = await directChannels.known(own);
					if (!known) return;
					reaching = [known];
				} catch (error) {
					// No destination was established; do not advertise an unusable tool.
					logger.warn(
						{ channel: session.homeChannel, err: error },
						"could not tell whether a direct channel reaches the conversation's person",
					);
					return;
				}
			}
			await notifyExtension(
				{
					notifier: directChannels,
					recipient: async () => recipientOf(session, own),
					channels: labels(reaching),
				},
				owner,
			)(pi);
		};
	};
}
