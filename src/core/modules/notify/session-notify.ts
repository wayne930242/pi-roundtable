import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
	/** The primary owner: the host's own turns, such as a report's, notify them, as 0.8 did. */
	owner: OwnerIdentity & { id: string };
	/**
	 * Whether a notice in a shared conversation can only be the primary owner's: the host has no
	 * other owner, and only owners may use notify. Its description then names them, as in 0.8.
	 */
	onlyOwnerNotified(): Promise<boolean>;
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
	// A failed lookup names no one: the speaker's words are true whoever it is.
	const onlyOwner = (session: SessionContext) =>
		deps.onlyOwnerNotified().catch((error: unknown) => {
			logger.warn(
				{ channel: session.homeChannel, err: error },
				"could not tell whether the primary owner is the only owner",
			);
			return false;
		});
	return (session) => {
		const providers = directChannels.providers();
		if (providers.length === 0) return null;
		const { conversation } = session;
		const own =
			conversation.visibility === "private"
				? conversation.principalId
				: undefined;
		return async (pi) => {
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
			// A shared conversation names the primary owner while only they can be notified, which
			// an owner granted or revoked while the session is open changes before its next turn.
			const describe = async () =>
				own === undefined && (await onlyOwner(session))
					? owner
					: session.addressee;
			await notifyExtension(
				{
					notifier: directChannels,
					recipient: async () => recipientOf(session, own),
					channels: labels(reaching),
				},
				await describe(),
				own === undefined ? describe : undefined,
			)(pi);
		};
	};
}
