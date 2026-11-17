import type {
	Admission,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import type { Contact, ContactAssessor } from "../identity/contact.ts";
import type { Logger } from "../kernel/log.ts";
import { actorOf } from "./actor-of.ts";

export interface AdmitOptions {
	logger: Logger;
	/** Who the authors of messages are; without it, no message carries a speaker. */
	contacts?: ContactAssessor;
	/** The surfaces already warned that their messages carry no actor. */
	warned: Set<string>;
}

/**
 * The claim's admission of the message, which carries the speaker its author resolves to; one
 * who cannot be resolved, such as while the database is down, reaches the claim as no one. The
 * author's contact is recorded, such as their first contact linked, only once the claim takes
 * the message, so a message nobody serves links or makes no one. A linked author the rules
 * refuse is still recorded as seen at no tier as the message is assessed, whether or not a
 * claim then takes it, at most once in a while. When that record fails, or finds them someone
 * else or no one now, such as linked elsewhere meanwhile, the message is dropped: it would run
 * as a principal that may not exist, such as one only assessed at a first contact. The claim
 * hears it through the admission's `dropped` or `unanswered`.
 */
export async function admitMessage(
	claim: ChannelClaim,
	message: InboundMessage,
	{ logger, contacts, warned }: AdmitOptions,
): Promise<{ admission: Admission; message: InboundMessage } | undefined> {
	const { speaker: _given, ...facts } = message;
	const actor = actorOf(message, warned, logger);
	let contact: Contact | undefined;
	if (actor && contacts)
		try {
			contact = await contacts.assess(actor, {
				conversation: message.channel,
			});
		} catch (error) {
			logger.error(
				{ channel: message.channel, err: error },
				"could not resolve who wrote a message; it reaches its claim as no one",
			);
		}
	const admittedAs: InboundMessage = contact
		? { ...facts, speaker: Object.freeze({ ...contact.speaker }) }
		: facts;
	const admission = claim.admit(admittedAs);
	if (!admission) return undefined;
	if (!contact) return { admission, message: admittedAs };
	try {
		const taken = await contact.take();
		if (taken?.principalId === contact.speaker.principalId)
			return { admission, message: admittedAs };
		logger.warn(
			{ channel: message.channel },
			"the author of a message was linked elsewhere, or refused, while it was admitted; it does not run",
		);
	} catch (error) {
		logger.error(
			{ channel: message.channel, err: error },
			"could not record who wrote a message; it does not run",
		);
	}
	if (admission.kind === "turn") admission.dropped?.();
	else
		admission.unanswered({
			status: "skipped",
			reason: "its author was not who they were when it was admitted",
		});
	return undefined;
}
