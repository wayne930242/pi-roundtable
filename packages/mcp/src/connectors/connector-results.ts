import type { VirtualServer } from "pi-roundtable/kit";

/** What `resync` found for one connector. */
export interface Resynced {
	connector: Connector;
	/** Tools left out of the virtual server because their names are too long. */
	skipped: string[];
	/** Tool names the virtual server serves now and did not before. */
	added: string[];
	/** Tool names the virtual server served before and does not now. */
	removed: string[];
}

/** One connector of `resyncAll`: what changed, or why it could not be read and was left as it was. */
export type ResyncOutcome =
	| ({ name: string } & Resynced)
	| { name: string; error: string };

/** A request the owner can fix; the message is shown to the owner as is. */
export class ConnectorError extends Error {
	/** Marks the error as one whose message the owner reads, for a host that does not know this class. */
	readonly refusal = true;
}

/** The gateway answered 429: its request limit is reached, and asking again at once only prolongs it. */
export class ConnectorRateLimited extends ConnectorError {}

export interface Connector {
	name: string;
	url: string;
	description: string;
	gatewayId: string;
	serverId: string;
	createdAt: Date;
	/** The virtual server's endpoint and tools; absent when it could not be read. */
	server?: VirtualServer;
}
