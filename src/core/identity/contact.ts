import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { ActorFacts } from "./actor-facts.ts";

/**
 * A person a surface reports, assessed before any claim takes their message: who they would be,
 * with nothing written yet.
 */
export interface Contact {
	/** The speaker they would be: their principal's, or at a first contact the principal they would claim or be admitted as. */
	readonly speaker: Speaker;
	/**
	 * Records the contact once a claim takes their message: claims their 0.8 principal or admits
	 * them first, then records them as seen. The speaker they are now, whose principal differs from
	 * the assessed one only when another process linked them meanwhile; undefined when they are no
	 * one now.
	 */
	take(): Promise<Speaker | undefined>;
}

/** Assesses the people of messages before a claim takes them, so nobody's message that no claim serves writes anything. Core-internal: the router's. */
export interface ContactAssessor {
	assess(
		facts: ActorFacts,
		scope?: { conversation?: ChannelKey },
	): Promise<Contact | undefined>;
}
