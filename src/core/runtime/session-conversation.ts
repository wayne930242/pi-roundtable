import type { ChannelKey } from "../domain/conversation.ts";
import type { TurnConversation, TurnRequest } from "../domain/ports.ts";
import {
	type Principal,
	SYSTEM_PRINCIPAL,
} from "../identity/principal-store.ts";
import { addresseeOf, type OwnerIdentity } from "../identity.ts";
import type { SessionConversation } from "../sessions.ts";
import { addressee, type Speaker, THE_SPEAKER } from "../speakers.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";

/**
 * Whom a new session's conversation serves: an agent's is shared; another is as the turn says,
 * else as the host's record says, else shared, never the owner's by default. A private one's
 * person is looked up for their name and pronouns.
 */
export async function sessionConversation(
	key: ChannelKey,
	request: Pick<TurnRequest, "agent" | "conversation"> | undefined,
	options: Pick<PiAgentRuntimeOptions, "conversationOf" | "principalOf">,
): Promise<SessionConversation> {
	if (request?.agent) return { visibility: "shared" };
	const given = request?.conversation ?? (await options.conversationOf?.(key));
	if (given?.visibility !== "private") return { visibility: "shared" };
	const principal = await options.principalOf?.(given.principalId);
	return {
		visibility: "private",
		principalId: given.principalId,
		...(principal ? { principal } : {}),
	};
}

/** Whether the turn names its conversation otherwise than the session was made for, so it is rebuilt. */
export function conversationChanged(
	session: SessionConversation,
	given: TurnConversation | undefined,
): boolean {
	if (!given) return false;
	if (given.visibility !== session.visibility) return true;
	return (
		given.visibility === "private" &&
		session.visibility === "private" &&
		given.principalId !== session.principalId
	);
}

/**
 * Whom a session's tool descriptions address: the primary owner as configured, so their own
 * conversations read as in 0.8; another private conversation's person by their name and
 * pronouns; and the speaker, unnamed, in a shared one or a private one of someone the host has
 * no name for.
 */
export function sessionAddressee(
	conversation: SessionConversation,
	owner: OwnerIdentity & { id: string },
): OwnerIdentity {
	if (conversation.visibility !== "private") return THE_SPEAKER;
	if (conversation.principalId === owner.id) return owner;
	const named = namedPrincipal(conversation);
	return named ? addresseeOf(named) : THE_SPEAKER;
}

/**
 * A private conversation's person, when the host knows them by a name: one carried over from 0.8
 * may be named by their id alone until someone names them, and an id is no name to address.
 */
export function namedPrincipal(
	conversation: SessionConversation,
): Principal | undefined {
	if (conversation.visibility !== "private") return undefined;
	const { principal } = conversation;
	return principal && principal.displayName !== principal.id
		? principal
		: undefined;
}

/**
 * Whom a turn's approvals and answers name: a private conversation's person as its session
 * addresses them; the host's own turns and the primary owner as the owner; anyone else, a
 * second owner too, by their name.
 */
export function turnAddressee(
	speaker: Speaker | undefined,
	session: { conversation: SessionConversation; addressee: OwnerIdentity },
	owner: OwnerIdentity & { id: string },
): OwnerIdentity {
	const { conversation } = session;
	if (
		speaker &&
		conversation.visibility === "private" &&
		speaker.principalId === conversation.principalId &&
		session.addressee !== THE_SPEAKER
	)
		return session.addressee;
	const own =
		!speaker ||
		speaker.principalId === owner.id ||
		speaker.principalId === SYSTEM_PRINCIPAL;
	return own ? owner : addressee({ ...speaker, tier: "member" }, owner);
}

/**
 * Whose memory a session's running turn reads: a private conversation's person's, whoever speaks
 * in it, and in a shared one the speaker's; no one's for the host's own turns there, nor while
 * no turn runs.
 */
export function memoryReader(
	conversation: SessionConversation,
	speaker: Speaker | undefined,
): string | undefined {
	if (conversation.visibility === "private") return conversation.principalId;
	if (!speaker || speaker.principalId === SYSTEM_PRINCIPAL) return undefined;
	return speaker.principalId;
}

/**
 * Why a turn may not run in the session's conversation: someone other than its person speaking
 * in a private one. The host's own turns may.
 */
export function refusedSpeaker(
	conversation: SessionConversation,
	speaker: Speaker,
): string | undefined {
	if (conversation.visibility !== "private") return undefined;
	if (
		speaker.principalId === conversation.principalId ||
		speaker.principalId === SYSTEM_PRINCIPAL
	)
		return undefined;
	return `the conversation is private to ${conversation.principalId}, so a turn of ${speaker.principalId} may not run in it`;
}
