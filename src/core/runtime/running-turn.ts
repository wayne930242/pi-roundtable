import type { ClientPort } from "../domain/client.ts";
import type { Speaker, Tier } from "../speakers.ts";

/** What the runtime keeps about a conversation's running turn, for its tools to read. */
export interface RunningTurn {
	tier: Tier;
	speaker: Speaker;
	/** Where the turn's request came from, as `TurnRequest.origin` says. */
	origin?: string;
	/** What the client that started the turn can do, as `TurnRequest.client` says. */
	client?: ClientPort;
	/** Whether the turn loads no memory. */
	withheld: boolean;
}
